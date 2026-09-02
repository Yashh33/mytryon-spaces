export function BottomSheet({ title, onClose, children }) {
  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}
