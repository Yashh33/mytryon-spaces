import { createContext, useCallback, useContext, useRef, useState } from "react";

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [message, setMessage] = useState(null);
  const timerRef = useRef(null);

  const showToast = useCallback((text) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMessage(text);
    timerRef.current = setTimeout(() => setMessage(null), 3200);
  }, []);

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      {message ? <div className="toast">{message}</div> : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
