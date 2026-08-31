import { describe, expect, it } from "vitest";

import { createCatApiImageModel } from "./cat-api-image-model";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
const pngBytes = Uint8Array.from(Buffer.from(pngBase64, "base64"));

function imageResponse(): Response {
  return Response.json({ data: [{ b64_json: pngBase64 }] });
}

describe("CatAPI Image Adapter", () => {
  it("无参考图时调用文生图端点，并返回解码后的图片", async () => {
    let capturedRequest: Request | undefined;
    const model = createCatApiImageModel({
      baseUrl: "https://maomiapi.com/v1/",
      apiKey: "test-api-key",
      modelId: "gpt-image-2",
      fetch: async (input, init) => {
        capturedRequest = new Request(input, init);
        return imageResponse();
      },
    });

    const image = await model.generate({ prompt: "画一只戴着帽子的猫" });

    expect(image).toEqual({ data: pngBytes, mediaType: "image/png" });
    expect(capturedRequest?.url).toBe(
      "https://maomiapi.com/v1/images/generations",
    );
    expect(capturedRequest?.method).toBe("POST");
    expect(capturedRequest?.headers.get("authorization")).toBe(
      "Bearer test-api-key",
    );
    await expect(capturedRequest?.json()).resolves.toEqual({
      model: "gpt-image-2",
      prompt: "画一只戴着帽子的猫",
      n: 1,
    });
  });

  it("有一张参考图时调用 multipart 编辑端点", async () => {
    let capturedRequest: Request | undefined;
    const model = createCatApiImageModel({
      baseUrl: "https://maomiapi.com/v1",
      apiKey: "test-api-key",
      modelId: "gpt-image-2",
      fetch: async (input, init) => {
        capturedRequest = new Request(input, init);
        return imageResponse();
      },
    });

    const image = await model.generate({
      prompt: "把背景改成黄色",
      referenceImage: pngBytes,
    });

    expect(image).toEqual({ data: pngBytes, mediaType: "image/png" });
    expect(capturedRequest?.url).toBe("https://maomiapi.com/v1/images/edits");
    expect(capturedRequest?.method).toBe("POST");
    expect(capturedRequest?.headers.get("content-type")).toMatch(
      /^multipart\/form-data; boundary=/,
    );

    const body = await capturedRequest?.formData();
    expect(body?.get("model")).toBe("gpt-image-2");
    expect(body?.get("prompt")).toBe("把背景改成黄色");
    expect(body?.get("n")).toBe("1");

    const referenceImage = body?.get("image");
    expect(referenceImage).toBeInstanceOf(File);
    expect((referenceImage as File).type).toBe("image/png");
    await expect((referenceImage as File).arrayBuffer()).resolves.toEqual(
      pngBytes.buffer,
    );
  });

  it("把 CatAPI 的错误响应交给上层处理", async () => {
    let requestCount = 0;
    const model = createCatApiImageModel({
      baseUrl: "https://maomiapi.com/v1",
      apiKey: "test-api-key",
      modelId: "gpt-image-2",
      fetch: async () => {
        requestCount += 1;
        return Response.json(
          { error: { message: "image provider failed", type: "api_error" } },
          { status: 502 },
        );
      },
    });

    await expect(model.generate({ prompt: "画一只猫" })).rejects.toThrow(
      "image provider failed",
    );
    expect(requestCount).toBe(1);
  });
});
