import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createUlid(now = Date.now()): string {
  return `${encodeTime(now)}${encodeRandom()}`;
}

function encodeTime(now: number): string {
  let value = Math.max(0, Math.floor(now));
  let output = "";
  for (let index = 0; index < 10; index += 1) {
    output = ENCODING[value % 32]! + output;
    value = Math.floor(value / 32);
  }
  return output;
}

function encodeRandom(): string {
  const bytes = randomBytes(16);
  let output = "";
  for (let index = 0; output.length < 16; index += 1) {
    output += ENCODING[bytes[index % bytes.length]! % 32]!;
  }
  return output;
}
