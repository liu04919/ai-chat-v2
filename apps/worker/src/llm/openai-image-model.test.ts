import { ATTACHMENT_MAX_SIZE_BYTES } from "@ai-chat/contracts";
import { createDownload } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createOpenAIImageModel } from "./openai-image-model";

const { downloadImageMock } = vi.hoisted(() => ({ downloadImageMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    createDownload: vi.fn((options: Parameters<typeof actual.createDownload>[0]) => {
      const download = actual.createDownload(options);
      return (request: Parameters<typeof download>[0]) =>
        downloadImageMock(request) ?? download(request);
    }),
  };
});

beforeEach(() => {
  downloadImageMock.mockReset();
});

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
const pngBytes = Uint8Array.from(Buffer.from(pngBase64, "base64"));

function imageResponse(): Response {
  return Response.json({ data: [{ b64_json: pngBase64 }] });
}

describe("OpenAI Images Image Adapter", () => {
  it("无参考图时调用文生图端点，并返回解码后的图片", async () => {
    let capturedRequest: Request | undefined;
    const model = createOpenAIImageModel({
      baseUrl: "https://maomiapi.com/v1/",
      apiKey: "test-api-key",
      modelId: "gpt-image-2.5",
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
      model: "gpt-image-2.5",
      prompt: "画一只戴着帽子的猫",
      n: 1,
    });
  });

  it("有一张参考图时调用 multipart 编辑端点", async () => {
    let capturedRequest: Request | undefined;
    const model = createOpenAIImageModel({
      baseUrl: "https://maomiapi.com/v1",
      apiKey: "test-api-key",
      modelId: "gpt-image-2.5",
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
    expect(body?.get("model")).toBe("gpt-image-2.5");
    expect(body?.get("prompt")).toBe("把背景改成黄色");
    expect(body?.get("n")).toBe("1");

    const referenceImage = body?.get("image");
    expect(referenceImage).toBeInstanceOf(File);
    expect((referenceImage as File).type).toBe("image/png");
    await expect((referenceImage as File).arrayBuffer()).resolves.toEqual(
      pngBytes.buffer,
    );
  });

  it("把 OpenAI Images 的错误响应交给上层处理", async () => {
    let requestCount = 0;
    const model = createOpenAIImageModel({
      baseUrl: "https://maomiapi.com/v1",
      apiKey: "test-api-key",
      modelId: "gpt-image-2.5",
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

  it.each([false, true])("URL 结果转成 base64，兼容参考图模式 %s", async (withReference) => {
    downloadImageMock.mockResolvedValue({ data: pngBytes, mediaType: "image/png" });
    const apiFetch = vi.fn(async () => Response.json({
      data: [{ url: "https://images.example.com/result.png", revised_prompt: "a cat" }],
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    }, { headers: { "content-length": "1", "content-encoding": "gzip" } }));
    const model = createOpenAIImageModel({
      baseUrl: "https://api.a6api.com/v1",
      apiKey: "test-api-key",
      modelId: "gpt-image-2.5",
      fetch: apiFetch,
    });

    await expect(model.generate({
      prompt: "画一只猫",
      ...(withReference ? { referenceImage: pngBytes } : {}),
    })).resolves.toEqual({ data: pngBytes, mediaType: "image/png" });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(createDownload).toHaveBeenCalledWith({ maxBytes: ATTACHMENT_MAX_SIZE_BYTES });
    expect(downloadImageMock).toHaveBeenCalledExactlyOnceWith({
      url: new URL("https://images.example.com/result.png"),
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("同时有 base64 和 URL 时直接使用 base64，不重复下载", async () => {
    const model = createOpenAIImageModel({
      baseUrl: "https://api.a6api.com/v1",
      apiKey: "test-api-key",
      modelId: "gpt-image-2.5",
      fetch: async () => Response.json({ data: [{ b64_json: pngBase64, url: "https://images.example.com/result.png" }] }),
    });
    await expect(model.generate({ prompt: "猫" })).resolves.toEqual({ data: pngBytes, mediaType: "image/png" });
    expect(downloadImageMock).not.toHaveBeenCalled();
  });

  it("图片下载失败向上抛出，不重新付费生成", async () => {
    downloadImageMock.mockRejectedValue(new Error("image download failed"));
    const apiFetch = vi.fn(async () => Response.json({ data: [{ url: "https://images.example.com/result.png" }] }));
    const model = createOpenAIImageModel({
      baseUrl: "https://api.a6api.com/v1",
      apiKey: "test-api-key",
      modelId: "gpt-image-2.5",
      fetch: apiFetch,
    });
    await expect(model.generate({ prompt: "猫" })).rejects.toThrow("image download failed");
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("用户取消同时中止 URL 下载", async () => {
    const controller = new AbortController();
    downloadImageMock.mockImplementation(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      controller.abort(new Error("用户取消"));
      abortSignal.throwIfAborted();
    });
    const model = createOpenAIImageModel({
      baseUrl: "https://api.a6api.com/v1",
      apiKey: "test-api-key",
      modelId: "gpt-image-2.5",
      fetch: async () => Response.json({ data: [{ url: "https://images.example.com/result.png" }] }),
    });
    await expect(model.generate({ prompt: "猫", abortSignal: controller.signal })).rejects.toThrow("用户取消");
  });

  it.each(["http://127.0.0.1/image.png", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd"])("拒绝不安全的图片 URL：%s", async (url) => {
    // 不 mock 下载结果，验证 SDK 的真实 URL 防护在联网前拒绝这些地址。
    const model = createOpenAIImageModel({
      baseUrl: "https://api.a6api.com/v1",
      apiKey: "test-api-key",
      modelId: "gpt-image-2.5",
      fetch: async () => Response.json({ data: [{ url }] }),
    });
    await expect(model.generate({ prompt: "猫" })).rejects.toThrow();
  });
});
