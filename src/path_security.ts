import fs from 'node:fs/promises';
import path from 'node:path';

export async function resolveAndValidatePathInRoots(params: {
  inputPath: string;
  allowedRoots: string[];
}): Promise<string> {
  const resolvedInput = path.resolve(params.inputPath);
  const realInput = await fs.realpath(resolvedInput);
  const allowed = await Promise.all(
    params.allowedRoots.map(async (r) => ensureTrailingSep(await fs.realpath(path.resolve(r))))
  );
  const realInputWithSep = ensureTrailingSep(realInput);

  const ok = allowed.some((root) => realInputWithSep.startsWith(root));
  if (!ok) {
    throw new Error(
      `Path is not allowed. input=${params.inputPath} resolved=${resolvedInput} real=${realInput} allowedRoots=${params.allowedRoots.join(',')}`
    );
  }

  return realInput;
}

function ensureTrailingSep(p: string): string {
  return p.endsWith(path.sep) ? p : `${p}${path.sep}`;
}
