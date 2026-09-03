/**
 * The operation registry (AGENTS.md, "Operation registry").
 *
 * One array, in the order of the frozen REST route table in
 * docs/spec-v1.md. The router is generated from it; issue #8 generates the MCP
 * tool list from it; the CLI reads it too. Adding an operation is adding one
 * entry here, so the three surfaces cannot drift apart.
 */
import {
  deleteOp,
  fileDownload,
  getOp,
  health,
  listOp,
  publishOp,
  updateOp,
} from "./drops.js";
import { configGet, configSet } from "./config.js";
import { userAdd, userList, userRemove } from "./users.js";
import type { Operation } from "./types.js";

export const OPERATIONS: Array<Operation<never>> = [
  health,
  publishOp,
  updateOp,
  getOp,
  listOp,
  deleteOp,
  fileDownload,
  userAdd,
  userList,
  userRemove,
  configGet,
  configSet,
] as unknown as Array<Operation<never>>;

export function operation(name: string): Operation<never> {
  const found = OPERATIONS.find((op) => op.name === name);
  if (found === undefined) throw new Error(`No operation named ${name}.`);
  return found;
}

export { routeOf } from "./types.js";
export type { Operation, OperationContext, OperationResult } from "./types.js";
