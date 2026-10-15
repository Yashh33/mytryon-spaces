import { useEffect, useState } from "react";

/** An <img> that says "Image not on this server" instead of showing a
 * broken picture — e.g. a render made on a laptop, viewed on the live site. */
export function SafeImg({ src, alt = "", className, style, ...rest }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => setMissing(false), [src]);
  if (missing || !src) {
    return (
      <div className={"img-missing" + (className ? ` ${className}` : "")} style={style} role="img" aria-label="Image not on this server">
        Image not on this server
      </div>
    );
  }
  return <img src={src} alt={alt} className={className} style={style} onError={() => setMissing(true)} {...rest} />;
}
