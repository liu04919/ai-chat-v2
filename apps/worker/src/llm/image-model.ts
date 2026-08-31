export type ImageModelRequest = {
  prompt: string;
  referenceImage?: Uint8Array;
  abortSignal?: AbortSignal;
};

export type GeneratedImage = {
  data: Uint8Array;
  mediaType: string;
};

export interface ImageModel {
  generate(request: ImageModelRequest): Promise<GeneratedImage>;
}
