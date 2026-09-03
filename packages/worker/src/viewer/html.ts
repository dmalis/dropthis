/**
 * The two things every page the viewer generates needs: escaped text and a
 * response with the viewer's own cache rule.
 *
 * `Cache-Control: no-cache, must-revalidate` is on the generated pages for the
 * same reason it is on file bodies — an update, an expiry or a password change
 * has to be visible on the visitor's very next request.
 */
import { VIEWER_CACHE_CONTROL } from "../serve.js";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": VIEWER_CACHE_CONTROL,
    },
  });
}
