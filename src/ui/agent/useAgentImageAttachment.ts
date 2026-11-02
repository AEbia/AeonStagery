import React, { useEffect, useRef, useState } from 'react';
import { loadDroppedImage, type DroppedImage } from './imageDrop';

const MAX_IMAGE_DIMENSION = 1568;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

interface ImageAttachment {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  previewUrl: string;
}

/**
 * Downscale + re-encode a picked image so the bytes stay within the transport
 * limits shared with the readImage tool (ADR0023): max dimension and byte cap.
 */
async function processPickedImage(file: File): Promise<ImageAttachment> {
  if (file.size === 0) throw new Error('图片为空，请选择有效的图片。');
  if (file.size > 32 * 1024 * 1024) throw new Error('原图超过 32 MB，请缩小后重试。');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('无法读取这张图片，请使用 PNG、JPEG、WebP 或 GIF 格式。');
  }
  try {
    if (bitmap.width * bitmap.height > 40_000_000) throw new Error('图片分辨率过高，请缩小后重试。');
    let scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法处理图片，请重试。');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9);
      });
      if (!blob) throw new Error('无法编码图片，请选择其他图片后重试。');
      if (blob.size <= MAX_IMAGE_BYTES) {
        return {
          name: file.name || '粘贴的图片.png',
          mimeType: blob.type,
          bytes: new Uint8Array(await blob.arrayBuffer()),
          previewUrl: URL.createObjectURL(blob),
        };
      }
      scale *= 0.75;
    }
    throw new Error('图片过大，请选择更小的图片。');
  } finally {
    bitmap.close();
  }
}

export function useAgentImageAttachment(selectedId: string | null, projectId: string | undefined, canAttachImage: boolean) {
  const [imageAttachment, setImageAttachment] = useState<ImageAttachment | null>(null);
  const [imageProcessing, setImageProcessing] = useState(false);
  const imagePickSequence = useRef(0);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    imagePickSequence.current += 1;
    setImageProcessing(false);
    setImageAttachment(null);
    setAttachError(null);
    return () => { imagePickSequence.current += 1; };
  }, [selectedId, projectId]);

  useEffect(() => () => {
    if (imageAttachment) URL.revokeObjectURL(imageAttachment.previewUrl);
  }, [imageAttachment]);

  const handlePickImage = () => {
    if (canAttachImage && !imageProcessing) fileInputRef.current?.click();
  };

  const attachImage = async (source: DroppedImage) => {
    if (!canAttachImage) return;
    const sequence = ++imagePickSequence.current;
    setAttachError(null);
    setImageProcessing(true);
    try {
      const file = await loadDroppedImage(source);
      if (sequence !== imagePickSequence.current) return;
      const attachment = await processPickedImage(file);
      if (sequence !== imagePickSequence.current) {
        URL.revokeObjectURL(attachment.previewUrl);
        return;
      }
      setImageAttachment(attachment);
    } catch (error) {
      if (sequence === imagePickSequence.current) {
        setAttachError(error instanceof Error ? error.message : '图片处理失败，请选择有效的图片后重试。');
      }
    } finally {
      if (sequence === imagePickSequence.current) setImageProcessing(false);
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await attachImage(file);
  };

  const removeImage = () => {
    imagePickSequence.current += 1;
    setImageProcessing(false);
    setImageAttachment(null);
  };

  const resetImages = () => {
    imagePickSequence.current += 1;
    setImageProcessing(false);
    setImageAttachment(null);
    setAttachError(null);
  };
  return {
    imageAttachment,
    setImageAttachment,
    imageProcessing,
    attachError,
    setAttachError,
    fileInputRef,
    handlePickImage,
    handleFileChange,
    removeImage,
    attachImage,
    resetImages,
  };
}

export type AgentImageAttachmentState = ReturnType<typeof useAgentImageAttachment>;
