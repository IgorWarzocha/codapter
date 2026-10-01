import { readFile } from "node:fs/promises";
import type { BackendImageInput } from "@codapter/core";

interface PiImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export async function convertImages(
  images?: readonly BackendImageInput[],
  signal?: AbortSignal
): Promise<readonly PiImageContent[] | undefined> {
  if (!images || images.length === 0) {
    return undefined;
  }

  const converted = await Promise.all(
    images.map(async (image) => {
      if (typeof image.data === "string" && image.data.length > 0) {
        return {
          type: "image" as const,
          data: image.data,
          mimeType: image.mimeType ?? "image/png",
        };
      }

      if (typeof image.path === "string" && image.path.length > 0) {
        const buffer = await readFile(image.path, { signal });
        return {
          type: "image" as const,
          data: buffer.toString("base64"),
          mimeType: image.mimeType ?? "image/png",
        };
      }

      if (typeof image.url === "string" && image.url.length > 0) {
        const response = await fetch(image.url, { ...(signal ? { signal } : {}) });
        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          type: "image" as const,
          data: buffer.toString("base64"),
          mimeType: image.mimeType ?? response.headers.get("content-type") ?? "image/png",
        };
      }

      throw new Error("Pi backend requires image data, file path, or URL");
    })
  );

  return converted;
}
