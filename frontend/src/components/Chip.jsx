export function Chip({ selected, onClick, children, dotColor }) {
  return (
    <button type="button" className={"chip" + (selected ? " selected" : "")} onClick={onClick}>
      {dotColor ? <span className="chip-dot" style={{ background: dotColor }} /> : null}
      {children}
    </button>
  );
}
