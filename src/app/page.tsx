import fs from "node:fs";
import path from "node:path";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

interface RouteInfo {
  method: string;
  path: string;
}

/**
 * This is a Next.js API backend, not FastAPI — there's no built-in OpenAPI/docs
 * page. This walks the actual `src/app/api` tree at request time so the list
 * below can never go stale as routes are added or removed.
 */
function discoverRoutes(dir: string, segments: string[] = []): RouteInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const routes: RouteInfo[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      routes.push(...discoverRoutes(path.join(dir, entry.name), [...segments, entry.name]));
    } else if (entry.name === "route.ts" || entry.name === "route.tsx") {
      const urlPath = "/" + segments.join("/");
      const source = fs.readFileSync(path.join(dir, entry.name), "utf-8");
      const methods = HTTP_METHODS.filter((m) => new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(source));
      for (const method of methods) routes.push({ method, path: urlPath });
    }
  }
  return routes;
}

export default function StatusPage() {
  const apiRoot = path.join(process.cwd(), "src", "app", "api");
  const routes = discoverRoutes(apiRoot, ["api"]).sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 32, maxWidth: 860, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Agent Mall Backend</h1>
      <p style={{ color: "#16a34a", fontWeight: 600, margin: "0 0 4px" }}>● Status: Active</p>
      <p style={{ color: "#666", margin: "0 0 20px", fontSize: 13 }}>
        {routes.length} route handler{routes.length === 1 ? "" : "s"} found under <code>src/app/api</code>.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={{ padding: "6px 8px" }}>Method</th>
            <th style={{ padding: "6px 8px" }}>Path</th>
          </tr>
        </thead>
        <tbody>
          {routes.map((r, i) => (
            <tr key={`${r.method}-${r.path}-${i}`} style={{ borderBottom: "1px solid #eee" }}>
              <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{r.method}</td>
              <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{r.path}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
