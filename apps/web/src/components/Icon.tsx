import { icons, type IconName } from "../icons.ts";

/** An MDI icon, sized by the font size and coloured by the text colour around it. */
export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg className={`icon ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={icons[name]} />
    </svg>
  );
}
