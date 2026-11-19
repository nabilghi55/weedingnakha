package storage

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// S3Config configures an S3-compatible private bucket (e.g. Cloudflare R2:
// Endpoint=https://<account>.r2.cloudflarestorage.com, Region=auto).
type S3Config struct {
	Endpoint        string
	Region          string
	Bucket          string
	AccessKeyID     string
	SecretAccessKey string
	// KeyPattern restricts which keys this client may touch. Defaults to the
	// photo key pattern; the backup client uses its own.
	KeyPattern *regexp.Regexp
}

// S3 implements Storage with AWS Signature V4. Browser uploads use presigned
// PUT URLs; server-side calls reuse presigned URLs with a 1-minute TTL, so no
// SDK is needed. The bucket must stay private.
type S3 struct {
	cfg    S3Config
	base   *url.URL
	client *http.Client
	now    func() time.Time
}

func NewS3(cfg S3Config, now func() time.Time) (*S3, error) {
	if cfg.Endpoint == "" || cfg.Bucket == "" || cfg.AccessKeyID == "" || cfg.SecretAccessKey == "" {
		return nil, fmt.Errorf("endpoint, bucket, access key id and secret access key are required")
	}
	u, err := url.Parse(strings.TrimRight(cfg.Endpoint, "/"))
	if err != nil || u.Scheme != "https" && u.Scheme != "http" || u.Host == "" {
		return nil, fmt.Errorf("invalid S3 endpoint")
	}
	if cfg.Region == "" {
		cfg.Region = "auto"
	}
	if cfg.KeyPattern == nil {
		cfg.KeyPattern = keyRe
	}
	if now == nil {
		now = time.Now
	}
	return &S3{cfg: cfg, base: u, client: &http.Client{Timeout: 60 * time.Second}, now: now}, nil
}

func (s *S3) validKey(key string) bool { return s.cfg.KeyPattern.MatchString(key) }

// awsEscape percent-encodes per the SigV4 spec (RFC 3986 unreserved set).
func awsEscape(s string, keepSlash bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == '/' && keepSlash:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

// sign builds a SigV4 query-signed URL (path-style). key may be "" for
// bucket-level requests (ListObjectsV2); extra adds signed query params.
func (s *S3) sign(method, key string, extra map[string]string, ttl time.Duration, headers map[string]string) string {
	if ttl > 7*24*time.Hour {
		ttl = 7 * 24 * time.Hour
	}
	now := s.now().UTC()
	amzDate := now.Format("20060102T150405Z")
	date := now.Format("20060102")
	scope := date + "/" + s.cfg.Region + "/s3/aws4_request"
	path := s.base.Path + "/" + s.cfg.Bucket
	if key != "" {
		path += "/" + key
	}
	canonURI := awsEscape(path, true)

	hdrs := map[string]string{"host": s.base.Host}
	for k, v := range headers {
		hdrs[strings.ToLower(k)] = strings.TrimSpace(v)
	}
	names := make([]string, 0, len(hdrs))
	for k := range hdrs {
		names = append(names, k)
	}
	sort.Strings(names)
	var canonHeaders strings.Builder
	for _, k := range names {
		canonHeaders.WriteString(k + ":" + hdrs[k] + "\n")
	}
	signedHeaders := strings.Join(names, ";")

	q := map[string]string{
		"X-Amz-Algorithm":     "AWS4-HMAC-SHA256",
		"X-Amz-Credential":    s.cfg.AccessKeyID + "/" + scope,
		"X-Amz-Date":          amzDate,
		"X-Amz-Expires":       strconv.Itoa(int(ttl.Seconds())),
		"X-Amz-SignedHeaders": signedHeaders,
	}
	for k, v := range extra {
		q[k] = v
	}
	qk := make([]string, 0, len(q))
	for k := range q {
		qk = append(qk, k)
	}
	sort.Strings(qk)
	parts := make([]string, 0, len(qk))
	for _, k := range qk {
		parts = append(parts, awsEscape(k, false)+"="+awsEscape(q[k], false))
	}
	canonQuery := strings.Join(parts, "&")

	canonReq := strings.Join([]string{method, canonURI, canonQuery, canonHeaders.String(), signedHeaders, "UNSIGNED-PAYLOAD"}, "\n")
	sum := sha256.Sum256([]byte(canonReq))
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(sum[:])

	k := hmacSHA256([]byte("AWS4"+s.cfg.SecretAccessKey), date)
	k = hmacSHA256(k, s.cfg.Region)
	k = hmacSHA256(k, "s3")
	k = hmacSHA256(k, "aws4_request")
	sig := hex.EncodeToString(hmacSHA256(k, toSign))

	return s.base.Scheme + "://" + s.base.Host + canonURI + "?" + canonQuery + "&X-Amz-Signature=" + sig
}

func (s *S3) presign(method, key string, ttl time.Duration, headers map[string]string) (string, error) {
	if !s.validKey(key) {
		return "", ErrInvalidKey
	}
	return s.sign(method, key, nil, ttl, headers), nil
}

func (s *S3) PresignPut(key, contentType string, size int64, ttl time.Duration) (PresignedRequest, error) {
	// Content-Type and Content-Length are signed, so the browser can upload
	// only the exact type and size the API authorised.
	u, err := s.presign(http.MethodPut, key, ttl, map[string]string{
		"content-type":   contentType,
		"content-length": strconv.FormatInt(size, 10),
	})
	if err != nil {
		return PresignedRequest{}, err
	}
	return PresignedRequest{URL: u, Method: http.MethodPut, Headers: map[string]string{"Content-Type": contentType}}, nil
}

func (s *S3) PresignGet(key string, ttl time.Duration) (string, error) {
	return s.presign(http.MethodGet, key, ttl, nil)
}

func (s *S3) send(ctx context.Context, method, u string, headers map[string]string, body []byte) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		if strings.EqualFold(k, "content-length") {
			continue
		}
		req.Header.Set(k, v)
	}
	if body != nil {
		req.ContentLength = int64(len(body))
	}
	return s.client.Do(req)
}

func (s *S3) do(ctx context.Context, method, key string, headers map[string]string, body []byte) (*http.Response, error) {
	u, err := s.presign(method, key, time.Minute, headers)
	if err != nil {
		return nil, err
	}
	return s.send(ctx, method, u, headers, body)
}

func (s *S3) Stat(ctx context.Context, key string) (int64, error) {
	res, err := s.do(ctx, http.MethodHead, key, nil, nil)
	if err != nil {
		return 0, err
	}
	res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return 0, ErrNotFound
	}
	if res.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("s3 head: %s", res.Status)
	}
	return res.ContentLength, nil
}

func (s *S3) Open(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	res, err := s.do(ctx, http.MethodGet, key, nil, nil)
	if err != nil {
		return nil, 0, err
	}
	if res.StatusCode == http.StatusNotFound {
		res.Body.Close()
		return nil, 0, ErrNotFound
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, 0, fmt.Errorf("s3 get: %s", res.Status)
	}
	return res.Body, res.ContentLength, nil
}

func (s *S3) Put(ctx context.Context, key, contentType string, data []byte) error {
	res, err := s.do(ctx, http.MethodPut, key, map[string]string{
		"content-type":   contentType,
		"content-length": strconv.Itoa(len(data)),
	}, data)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("s3 put: %s", res.Status)
	}
	return nil
}

func (s *S3) Delete(ctx context.Context, key string) error {
	res, err := s.do(ctx, http.MethodDelete, key, nil, nil)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode/100 != 2 && res.StatusCode != http.StatusNotFound {
		return fmt.Errorf("s3 delete: %s", res.Status)
	}
	return nil
}

type listResult struct {
	IsTruncated           bool   `xml:"IsTruncated"`
	NextContinuationToken string `xml:"NextContinuationToken"`
	Contents              []struct {
		Key          string    `xml:"Key"`
		Size         int64     `xml:"Size"`
		LastModified time.Time `xml:"LastModified"`
	} `xml:"Contents"`
}

// List pages through ListObjectsV2 for prefix.
func (s *S3) List(ctx context.Context, prefix string) ([]ObjectInfo, error) {
	var out []ObjectInfo
	token := ""
	for page := 0; page < 10000; page++ {
		q := map[string]string{"list-type": "2", "prefix": prefix, "max-keys": "1000"}
		if token != "" {
			q["continuation-token"] = token
		}
		res, err := s.send(ctx, http.MethodGet, s.sign(http.MethodGet, "", q, time.Minute, nil), nil, nil)
		if err != nil {
			return nil, err
		}
		body, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
		res.Body.Close()
		if err != nil {
			return nil, err
		}
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("s3 list: %s", res.Status)
		}
		var lr listResult
		if err := xml.Unmarshal(body, &lr); err != nil {
			return nil, fmt.Errorf("s3 list: %w", err)
		}
		for _, c := range lr.Contents {
			out = append(out, ObjectInfo{Key: c.Key, Size: c.Size, LastModified: c.LastModified})
		}
		if !lr.IsTruncated || lr.NextContinuationToken == "" {
			return out, nil
		}
		token = lr.NextContinuationToken
	}
	return out, fmt.Errorf("s3 list: too many pages")
}
