type WebSocketLike = {
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
};

export function bindCurrentWebSocket<T extends WebSocketLike>(
  socket: T,
  isCurrent: (candidate: T) => boolean,
  handlers: {
    open: (event: any) => void;
    message: (event: any) => void;
    close: (event: any) => void;
  },
) {
  const guard = (handler: (event: any) => void) => (event: any) => {
    if (isCurrent(socket)) handler(event);
  };
  socket.onopen = guard(handlers.open);
  socket.onmessage = guard(handlers.message);
  socket.onclose = guard(handlers.close);
}

export function parseWebSocketMessage(value: string | Uint8Array): unknown | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
