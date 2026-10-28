package main

import (
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

var extraMIME = map[string]string{
	".html":  "text/html; charset=utf-8",
	".htm":   "text/html; charset=utf-8",
	".js":    "application/javascript; charset=utf-8",
	".mjs":   "application/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".map":   "application/json; charset=utf-8",
	".png":   "image/png",
	".svg":   "image/svg+xml",
	".ico":   "image/x-icon",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".gif":   "image/gif",
	".webp":  "image/webp",
	".woff":  "font/woff",
	".woff2": "font/woff2",
	".txt":   "text/plain; charset=utf-8",
}

/* serveStatic serves the web UI from $TRIM_APPDEST/www.
 *
 * Every request path is resolved against the document root and rejected when
 * it escapes it: the gateway forwards user-controlled URLs, so traversal must
 * be impossible rather than unlikely. */
func serveStatic(w http.ResponseWriter, r *http.Request, urlPath string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method-not-allowed"})
		return
	}
	rel := strings.TrimPrefix(urlPath, "/")
	if strings.Contains(rel, "..") || strings.Contains(rel, "\x00") {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	rel = path.Clean("/" + rel)
	if rel == "/" || rel == "" {
		rel = "/index.html"
	}
	full := filepath.Join(cfg.WWWRoot, filepath.FromSlash(rel))

	// Defence in depth: the cleaned path must still live inside the root.
	rootAbs, err1 := filepath.Abs(cfg.WWWRoot)
	fileAbs, err2 := filepath.Abs(full)
	if err1 != nil || err2 != nil || !strings.HasPrefix(fileAbs, rootAbs+string(os.PathSeparator)) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	st, err := os.Stat(fileAbs)
	if err != nil {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}
	if st.IsDir() {
		fileAbs = filepath.Join(fileAbs, "index.html")
		st, err = os.Stat(fileAbs)
		if err != nil {
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
	}

	f, err := os.Open(fileAbs)
	if err != nil {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}
	defer f.Close()

	ext := strings.ToLower(filepath.Ext(fileAbs))
	ctype := extraMIME[ext]
	if ctype == "" {
		if guess := mime.TypeByExtension(ext); guess != "" {
			ctype = guess
		} else {
			ctype = "application/octet-stream"
		}
	}
	// The UI is a single page with a polling script; stale HTML/JS after an
	// upgrade is a real support cost, so those two are always revalidated.
	switch ext {
	case ".html", ".htm", ".js", ".css":
		w.Header().Set("Cache-Control", "no-cache")
	default:
		w.Header().Set("Cache-Control", "public, max-age=300")
	}
	w.Header().Set("Content-Type", ctype)
	http.ServeContent(w, r, filepath.Base(fileAbs), st.ModTime(), f)
}
