/**
 * The two scraps every result line shares. The lines themselves live on their
 * operation entries (`registry/types.ts`, `ResultLine`).
 */
export const asDrop = (value: unknown) => value as { url: string; state: string };

export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
