// Package fsutil holds crash-safe file helpers.
package fsutil

import (
	"os"
	"path/filepath"
)

// WriteFileAtomic durably replaces path with data:
//
//  1. write a temporary file in the same directory,
//  2. fsync the temporary file,
//  3. atomically rename it over path,
//  4. fsync the parent directory so the rename itself survives a crash.
//
// Readers therefore see either the complete old file or the complete new
// one, never a partial write — even after power loss.
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(perm); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	return SyncDir(dir)
}

// SyncDir fsyncs a directory (persisting renames/creates inside it).
func SyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// CleanTemp removes temporary files left behind by an interrupted
// WriteFileAtomic in dir.
func CleanTemp(dir string) {
	matches, _ := filepath.Glob(filepath.Join(dir, ".*.tmp-*"))
	for _, m := range matches {
		_ = os.Remove(m)
	}
}
