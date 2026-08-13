import type { ReactNode, SVGProps } from 'react';

export type DrawIconName =
  | 'sound-on'
  | 'sound-off'
  | 'round'
  | 'friend-route'
  | 'export'
  | 'invitation'
  | 'private-link'
  | 'warning'
  | 'removal';

interface Props extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: DrawIconName;
}

export function DrawIcon({ name, className, ...props }: Props) {
  const paths = {
    'sound-on': (
      <>
        <path d="M4 17.5h9M6 17.5V7.2l3-2.7 3 2.7v10.3M6 10.2h6" />
        <circle cx="9" cy="13.7" r="1.25" fill="currentColor" stroke="none" />
        <path d="M15 9.2c1.5.8 2.2 1.7 2.2 2.8s-.7 2-2.2 2.8M17.4 6.7c2.2 1.4 3.3 3.2 3.3 5.3s-1.1 3.9-3.3 5.3" />
      </>
    ),
    'sound-off': (
      <>
        <path d="M4 17.5h9M6 17.5V7.2l3-2.7 3 2.7v10.3M6 10.2h6" />
        <circle cx="9" cy="13.7" r="1.25" fill="currentColor" stroke="none" />
        <path d="M15.2 9.2v5.6M18.3 8v8" />
      </>
    ),
    round: (
      <>
        <path d="M3.5 6.2h17v11.6h-17zM12 6.2v11.6M3.5 12h17M8.1 6.2V12m7.8 0v5.8" />
        <circle cx="5.8" cy="9.1" r="1" fill="currentColor" stroke="none" />
        <circle cx="18.2" cy="14.9" r="1" fill="currentColor" stroke="none" />
      </>
    ),
    'friend-route': (
      <>
        <path d="M3.5 18.5h17M6 18.5V6h12v12.5M6 11.8h12M12 6v12.5" />
        <circle cx="8.8" cy="8.8" r="1.35" fill="currentColor" stroke="none" />
        <circle cx="15.3" cy="15.2" r="1.35" fill="currentColor" stroke="none" />
        <path d="M9.9 9.9c1.3 1 2.4 2.1 4.2 4" strokeDasharray="1.2 2.1" />
      </>
    ),
    export: (
      <>
        <path d="M4 6.3h11.5v12H4zM4 10.2h11.5M9.8 6.3v12" />
        <circle cx="8" cy="13.9" r="1.2" fill="currentColor" stroke="none" />
        <path d="M9.2 13.5c4.7-1.2 7.7-3.2 9.7-6.2M16.3 7.2l2.9-.2-.2 2.9" />
      </>
    ),
    invitation: (
      <>
        <path d="M3.5 6.2h17v11.6h-17zM12 6.2v11.6M3.5 12h17" />
        <path d="M7.2 15.8c1.8-1.8 3.4-2.8 4.8-3.1 1.5-.3 3.1-1.5 4.8-3.7" strokeDasharray="1.3 2" />
        <circle cx="7" cy="16" r="1.3" fill="currentColor" stroke="none" />
        <circle cx="17" cy="8.8" r="1.3" fill="currentColor" stroke="none" />
      </>
    ),
    'private-link': (
      <>
        <path d="M3.5 6.2h17v11.6h-17zM12 6.2v11.6M3.5 12h17" />
        <path d="M8.2 17.8v-4.5h7.6v4.5M9.8 13.3v-1.2a2.2 2.2 0 0 1 4.4 0v1.2" />
        <circle cx="12" cy="15.6" r=".8" fill="currentColor" stroke="none" />
      </>
    ),
    warning: (
      <>
        <path d="M3.5 6.2h17v11.6h-17zM12 6.2v11.6M3.5 12h17" />
        <circle cx="12" cy="12" r="3.2" />
        <path d="M12 10.2v2.4m0 1.5v.1" />
      </>
    ),
    removal: (
      <>
        <path d="M3.5 6.2h17v11.6h-17zM12 6.2v11.6M3.5 12h17" />
        <circle cx="12" cy="12" r="3.4" />
        <path d="m10.5 10.5 3 3m0-3-3 3" />
      </>
    ),
  } satisfies Record<DrawIconName, ReactNode>;

  return (
    <svg
      className={`draw-icon${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
