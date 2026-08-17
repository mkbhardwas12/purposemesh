import type { SVGProps } from "react";

export type IconName =
  | "activity"
  | "audit"
  | "capsule"
  | "check"
  | "chevron"
  | "close"
  | "code"
  | "data"
  | "key"
  | "lock"
  | "menu"
  | "refresh"
  | "roles"
  | "search"
  | "shield"
  | "signout"
  | "spark"
  | "user"
  | "warning";

const paths: Record<IconName, React.ReactNode> = {
  activity: <path d="M3 12h4l2.4-6 4.2 12 2.3-6H21" />,
  audit: (
    <>
      <path d="M6 3h12v18H6z" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </>
  ),
  capsule: (
    <>
      <path d="M8.2 4.2a5 5 0 0 1 7.1 0l4.5 4.5a5 5 0 0 1-7.1 7.1L8.2 11.3a5 5 0 0 1 0-7.1Z" />
      <path d="m9.8 12.9 7.1-7.1" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  code: <path d="m8 9-3 3 3 3m8-6 3 3-3 3m-3-9-2 12" />,
  data: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8m-3 3 2 2m-5 1 2 2" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  refresh: <path d="M20 6v5h-5M4 18v-5h5M18.5 9A7 7 0 0 0 6 6.5L4 9m2 6a7 7 0 0 0 12.5 2.5L20 15" />,
  roles: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 19c.6-3.2 2.6-5 6-5s5.4 1.8 6 5M16 5h5M18.5 2.5v5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  shield: <path d="M12 3 5 6v5c0 4.8 2.8 8.1 7 10 4.2-1.9 7-5.2 7-10V6l-7-3Zm-3 9 2 2 4-5" />,
  signout: <path d="M10 5H5v14h5M14 8l4 4-4 4m4-4H9" />,
  spark: <path d="m4 16 4-5 4 3 4-7 4 3" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c.8-4.2 3.5-6 8-6s7.2 1.8 8 6" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 2.8 20h18.4L12 3Z" />
      <path d="M12 9v5m0 3h.01" />
    </>
  ),
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
