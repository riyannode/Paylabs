export function platformLabel(platform?: string | null): string {
  if (!platform) return "Website";
  if (platform === "github") return "GitHub Repository";
  if (platform === "github_pages") return "GitHub Pages";
  if (platform === "vercel") return "Vercel";
  if (platform === "netlify") return "Netlify";
  if (platform === "rss_publisher") return "RSS Publisher";
  if (platform === "twitter") return "X / Twitter";
  if (platform === "youtube") return "YouTube";
  if (platform === "medium") return "Medium";
  if (platform === "substack") return "Substack";
  return "Website";
}
