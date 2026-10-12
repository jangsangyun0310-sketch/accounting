// 사진 줄이기 (사목일지 · 비품대장 공용)

/** 휴대폰 사진(수 MB)을 긴 쪽 1600px JPEG 로 줄인다 (약 0.3MB) */
export async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('사진 파일을 열 수 없습니다. JPG · PNG 사진을 골라 주세요.'); });
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const q of [0.82, 0.7, 0.55]) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length < 1_400_000) return url;
  }
  throw new Error('사진이 너무 큽니다.');
}
