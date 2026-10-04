// API 응답과 오류 형식

export class ApiError extends Error {
  /**
   * @param {number} status HTTP 상태
   * @param {string} code   프로그램용 오류 코드
   * @param {string} message 사용자에게 보여줄 한국어 메시지
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function errorResponse(err) {
  return json({ error: { code: err.code, message: err.message } }, err.status);
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, 'BAD_JSON', '요청 형식이 올바르지 않습니다.');
  }
}
