/**
 * `/_skill.md` — this instance's agent skill, served live (docs/spec-v1.md,
 * story 77; AGENTS.md, "Serve the agent skill from the instance").
 *
 * The prose is `skills/instance-skill.md`, one template in the repo; the
 * values are the instance's own — its canonical URL and the policy it holds
 * right now, never the source's defaults — and the tool sections are rendered
 * from `registry/tools.ts`, the same text the MCP tool list carries. One
 * source, so the skill an agent reads and the tools it is offered say the
 * same thing.
 */
import template from "../../../skills/instance-skill.md";
import type { InstanceConfig } from "./instance-config.js";
import { MAX_FILES_PER_CALL, MAX_URL_ENTRIES } from "./registry/fields.js";
import { toolSurface } from "./mcp/tools.js";
import type { Tool } from "./mcp/tools.js";
import { TOOL_TEXT } from "./registry/tools.js";

export function renderSkill(config: InstanceConfig): string {
  const origin = config.canonicalUrl.replace(/\/+$/, "");
  const policy = config.policy;
  const tools = toolSurface();

  const values: Record<string, string> = {
    base_url: origin,
    mcp_url: `${origin}/_api/mcp`,
    max_request_bytes: String(policy.max_request_bytes),
    max_request_mib: mebibytes(policy.max_request_bytes),
    max_files: String(MAX_FILES_PER_CALL),
    max_unhashed_bytes: String(policy.max_unhashed_bytes),
    max_file_bytes: String(policy.max_file_bytes),
    max_url_entries: String(MAX_URL_ENTRIES),
    expiry_default: policy.expiry.default,
    expiry_max: policy.expiry.max,
    allow_never: policy.expiry.allow_never ? "allowed" : "refused",
    password_rule: passwordRule(tools),
    tools: tools.filter((tool) => tool.scope === "user").map(section).join("\n\n"),
    admin_tools: tools.filter((tool) => tool.scope === "admin").map(section).join("\n\n"),
  };

  return template
    // A rule that does not apply takes its line with it, not just its words.
    .replace("{{password_rule}}\n", values.password_rule === "" ? "" : "{{password_rule}}\n")
    .replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}

function section(tool: Tool): string {
  return `### \`${tool.name}\` — ${tool.title}\n\n${tool.description}`;
}

/**
 * The password rule is a bullet only while `publish` takes a password: the
 * tool text already gates its sentence on the schema (`mcp/tools.ts`), and
 * the skill follows the same gate rather than promising a field the schema
 * refuses.
 */
function passwordRule(tools: Tool[]): string {
  const publish = tools.find((tool) => tool.operation === "publish");
  const properties = (publish?.inputSchema.properties ?? {}) as Record<string, unknown>;
  if (!("password" in properties)) return "";
  const sentence = TOOL_TEXT.publish?.whenField?.password ?? "";
  return `- **Passwords are shown once.** ${sentence} Never from \`dropthis_get\` or \`dropthis_list\`.`;
}

function mebibytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return Number.isInteger(mib) ? String(mib) : mib.toFixed(2);
}
