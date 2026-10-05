import React from 'react';

export type IconProps = React.SVGProps<SVGSVGElement> & {
  size?: number | string;
  title?: string;
};

type IconBaseProps = IconProps & {
  children: React.ReactNode;
  fill?: string;
  stroke?: string;
  strokeWidth?: number | string;
};

const mergeClassName = (className?: string) => ['mgf-icon', className].filter(Boolean).join(' ');

const IconBase = ({
  children,
  size,
  width,
  height,
  className,
  fill = 'none',
  stroke = 'currentColor',
  strokeWidth = 2,
  strokeLinecap = 'round',
  strokeLinejoin = 'round',
  'aria-hidden': ariaHidden,
  ...props
}: IconBaseProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width ?? size ?? 24}
    height={height ?? size ?? 24}
    viewBox="0 0 24 24"
    fill={fill}
    stroke={stroke}
    strokeWidth={strokeWidth}
    strokeLinecap={strokeLinecap}
    strokeLinejoin={strokeLinejoin}
    className={mergeClassName(className)}
    aria-hidden={ariaHidden ?? (props.role || props['aria-label'] || props['aria-labelledby'] ? undefined : true)}
    {...props}
  >
    {children}
  </svg>
);

// Lightweight, sleek SVG icons to replace emojis
export const IconPlay = (props: IconProps) => (
  <IconBase fill="currentColor" stroke="none" {...props}><path d="M5 3l14 9-14 9V3z" /></IconBase>
);

export const IconPause = (props: IconProps) => (
  <IconBase fill="currentColor" stroke="none" {...props}><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></IconBase>
);

export const IconSquare = (props: IconProps) => (
  <IconBase fill="currentColor" stroke="none" {...props}><rect x="5" y="5" width="14" height="14" rx="2" /></IconBase>
);

export const IconArrowDown = (props: IconProps) => (
  <IconBase {...props}><line x1="12" y1="4" x2="12" y2="20" /><polyline points="6 14 12 20 18 14" /></IconBase>
);

export const IconSkipBack = (props: IconProps) => (
  <IconBase {...props}><polygon points="19 20 9 12 19 4 19 20" /><line x1="5" y1="19" x2="5" y2="5" /></IconBase>
);

export const IconCaretLeft = (props: IconProps) => (
  <IconBase fill="currentColor" stroke="none" {...props}><polygon points="17 19 7 12 17 5 17 19" /></IconBase>
);

export const IconCaretRight = (props: IconProps) => (
  <IconBase fill="currentColor" stroke="none" {...props}><polygon points="7 19 17 12 7 5 7 19" /></IconBase>
);

export const IconFolder = (props: IconProps) => (
  <IconBase {...props}><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" /></IconBase>
);

export const IconFilm = (props: IconProps) => (
  <IconBase {...props}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M7 3v18" /><path d="M3 7.5h4" /><path d="M3 12h18" /><path d="M3 16.5h4" /><path d="M17 3v18" /><path d="M17 7.5h4" /><path d="M17 16.5h4" /></IconBase>
);

export const IconSave = (props: IconProps) => (
  <IconBase {...props}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></IconBase>
);

export const IconPlus = (props: IconProps) => (
  <IconBase {...props}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></IconBase>
);

export const IconTrash = (props: IconProps) => (
  <IconBase {...props}><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></IconBase>
);

export const IconSettings = (props: IconProps) => (
  <IconBase {...props}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></IconBase>
);

export const IconClock = (props: IconProps) => (
  <IconBase {...props}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></IconBase>
);

export const IconLayers = (props: IconProps) => (
  <IconBase {...props}><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 12 12 17 22 12" /><polyline points="2 17 12 22 22 17" /></IconBase>
);

export const IconMessageCircle = (props: IconProps) => (
  <IconBase {...props}><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" /></IconBase>
);

export const IconCamera = (props: IconProps) => (
  <IconBase {...props}><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="3" /></IconBase>
);

export const IconUser = (props: IconProps) => (
  <IconBase {...props}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></IconBase>
);

export const IconUsers = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </IconBase>
);

export const IconImage = (props: IconProps) => (
  <IconBase {...props}><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></IconBase>
);

export const IconActivity = (props: IconProps) => (
  <IconBase {...props}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></IconBase>
);

export const IconMoon = (props: IconProps) => (
  <IconBase {...props}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></IconBase>
);

export const IconSun = (props: IconProps) => (
  <IconBase {...props}><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></IconBase>
);

export const IconTarget = (props: IconProps) => (
  <IconBase {...props}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></IconBase>
);

export const IconZoomIn = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
    <line x1="11" y1="8" x2="11" y2="14" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </IconBase>
);

export const IconZoomOut = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </IconBase>
);

export const IconMaximize = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
  </IconBase>
);

export const IconCrosshair = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="12" cy="12" r="10" />
    <line x1="22" y1="12" x2="18" y2="12" />
    <line x1="6" y1="12" x2="2" y2="12" />
    <line x1="12" y1="6" x2="12" y2="2" />
    <line x1="12" y1="22" x2="12" y2="18" />
  </IconBase>
);


export const IconRefresh = (props: IconProps) => (
  <IconBase {...props}><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 16h5v5" /></IconBase>
);

export const IconCheck = (props: IconProps) => (
  <IconBase {...props}><polyline points="20 6 9 17 4 12" /></IconBase>
);

export const IconCopy = (props: IconProps) => (
  <IconBase {...props}><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></IconBase>
);

export const IconEye = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </IconBase>
);

export const IconEyeOff = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
    <line x1="2" x2="22" y1="2" y2="22" />
  </IconBase>
);

export const IconX = (props: IconProps) => (
  <IconBase {...props}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></IconBase>
);

export const IconChevronUp = (props: IconProps) => (
  <IconBase {...props}><path d="m18 15-6-6-6 6" /></IconBase>
);

export const IconChevronDown = (props: IconProps) => (
  <IconBase {...props}><path d="m6 9 6 6 6-6" /></IconBase>
);

export const IconChevronLeft = (props: IconProps) => (
  <IconBase {...props}><path d="m15 18-6-6 6-6" /></IconBase>
);

export const IconChevronRight = (props: IconProps) => (
  <IconBase {...props}><path d="m9 18 6-6-6-6" /></IconBase>
);

export const IconArrowLeft = (props: IconProps) => (
  <IconBase {...props}><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></IconBase>
);

export const IconSend = (props: IconProps) => (
  <IconBase {...props}><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></IconBase>
);

export const IconVolume2 = (props: IconProps) => (
  <IconBase {...props}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></IconBase>
);

export const IconSearch = (props: IconProps) => (
  <IconBase {...props}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></IconBase>
);

export const IconInfo = (props: IconProps) => (
  <IconBase {...props}><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></IconBase>
);

export const IconUndo = (props: IconProps) => (
  <IconBase {...props}><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" /></IconBase>
);

export const IconRedo = (props: IconProps) => (
  <IconBase {...props}><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" /></IconBase>
);

export const IconPaste = (props: IconProps) => (
  <IconBase {...props}><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></IconBase>
);

export const IconPencil = (props: IconProps) => (
  <IconBase {...props}><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" /></IconBase>
);

export const IconDuplicate = (props: IconProps) => (
  <IconBase {...props}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></IconBase>
);

export const IconFilter = (props: IconProps) => (
  <IconBase {...props}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></IconBase>
);

export const IconLoop = (props: IconProps) => (
  <IconBase {...props}><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></IconBase>
);

export const IconGripVertical = (props: IconProps) => (
  <IconBase {...props}><circle cx="9" cy="5" r="1" /><circle cx="15" cy="5" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="19" r="1" /><circle cx="15" cy="19" r="1" /></IconBase>
);

export const IconFile = (props: IconProps) => (
  <IconBase {...props}><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" /></IconBase>
);

export const IconFileText = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M8 13h8" />
    <path d="M8 17h6" />
  </IconBase>
);

export const IconStar = (props: IconProps) => (
  <IconBase {...props}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </IconBase>
);

export const IconExternalLink = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </IconBase>
);

export const IconMarker = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M12 3 6 9h4v9l2 3 2-3V9h4L12 3z" fill="currentColor" fillOpacity="0.18" />
    <path d="M12 3 6 9h4v9l2 3 2-3V9h4L12 3z" />
  </IconBase>
);

export const IconSelectLeft = (props: IconProps) => (
  <IconBase {...props}><path d="M20 4v16" /><path d="M4 12h12" /><path d="m10 6-6 6 6 6" /></IconBase>
);

export const IconSelectRight = (props: IconProps) => (
  <IconBase {...props}><path d="M4 4v16" /><path d="M8 12h12" /><path d="m14 6 6 6-6 6" /></IconBase>
);

export const IconWarning = (props: IconProps) => (
  <IconBase {...props}><path d="M12 3 2 21h20L12 3z" /><path d="M12 9v5" /><path d="M12 18h.01" /></IconBase>
);

export const IconError = (props: IconProps) => (
  <IconBase {...props}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></IconBase>
);

export const IconTimelineDialogue = (props: IconProps) => (
  <IconBase strokeWidth="2.4" {...props}>
    <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
    <path d="M8 10h8" opacity="0.55" />
  </IconBase>
);

export const IconTimelineMotion = (props: IconProps) => (
  <IconBase strokeWidth="2.4" {...props}>
    <path d="M13 2 4 14h8l-1 8 9-12h-8l1-8Z" fill="currentColor" fillOpacity="0.16" />
    <path d="M13 2 4 14h8l-1 8 9-12h-8l1-8Z" />
  </IconBase>
);

export const IconTimelineCamera = (props: IconProps) => (
  <IconBase strokeWidth="2.3" {...props}>
    <path d="M5 8h3l2-3h4l2 3h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" />
    <circle cx="12" cy="14" r="3" />
    <path d="M18 5h2" opacity="0.55" />
  </IconBase>
);

export const IconTimelineEnvironment = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8" cy="9" r="1.5" />
    <path d="M4 18 9 13l3 3 4-5 5 7" />
  </IconBase>
);

export const IconTimelineEnvironmentLayer = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <rect x="3" y="7" width="14" height="11" rx="2" />
    <path d="M7 4h14v11" />
    <circle cx="7.5" cy="11" r="1.2" />
    <path d="M4 17 8 13l2.5 2.5 3-3.5 3.5 5" />
  </IconBase>
);

export const IconTimelineLens = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3" opacity="0.7" />
    <path d="M4 12h4M16 12h4M12 4v4M12 16v4" opacity="0.5" />
  </IconBase>
);

export const IconTimelineLensModulate = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <circle cx="12" cy="12" r="8" />
    <path d="M5 13h3l2-5 4 10 2-5h3" />
    <path d="M12 4v2M12 18v2" opacity="0.55" />
  </IconBase>
);

export const IconTimelineComposite = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <rect x="4" y="4" width="13" height="13" rx="2" />
    <rect x="7" y="7" width="13" height="13" rx="2" opacity="0.65" />
    <path d="m9 9 8 8" />
  </IconBase>
);

export const IconTimelineCompositeModulate = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <rect x="4" y="5" width="12" height="12" rx="2" />
    <rect x="8" y="8" width="12" height="12" rx="2" opacity="0.55" />
    <path d="M6 15h3l2-5 3 8 2-4h3" />
  </IconBase>
);

export const IconTimelineCharacterAdd = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M3 21v-1a6 6 0 0 1 12 0v1" />
    <path d="M19 8v6M22 11h-6" />
  </IconBase>
);

export const IconTimelineCharacterRemove = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M3 21v-1a6 6 0 0 1 12 0v1" />
    <path d="M22 11h-7" />
  </IconBase>
);

export const IconTimelineCharacterMove = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <circle cx="8" cy="8" r="3" />
    <path d="M3 21v-1a5 5 0 0 1 10 0v1" />
    <path d="M16 7h5M19 4l3 3-3 3" />
    <path d="M18 15h-5M15 12l-3 3 3 3" />
  </IconBase>
);

export const IconTimelineTransform = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <path d="M15 3h6v6" />
    <path d="M9 21H3v-6" />
    <path d="M21 3l-7 7" />
    <path d="M3 21l7-7" />
  </IconBase>
);

export const IconTimelineExpression = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <circle cx="12" cy="12" r="8" />
    <path d="M9 10h.01M15 10h.01" />
    <path d="M8.5 14.5c1.8 2 5.2 2 7 0" />
  </IconBase>
);

export const IconTimelineLook = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
    <circle cx="12" cy="12" r="2.5" />
  </IconBase>
);

export const IconTimelineBlink = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <path d="M3 12c2.6-3 5.6-4.5 9-4.5s6.4 1.5 9 4.5" />
    <path d="M4 12c2.5 2.6 5.2 4 8 4s5.5-1.4 8-4" opacity="0.55" />
    <path d="M7 6 5.5 4M12 5V3M17 6l1.5-2" opacity="0.5" />
  </IconBase>
);

export const IconTimelineCameraPath = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <path d="M4 17c4-9 9 3 16-6" />
    <circle cx="4" cy="17" r="2" />
    <circle cx="20" cy="11" r="2" />
    <path d="M9 6h5l2 3h3" opacity="0.65" />
  </IconBase>
);

export const IconTimelineCameraShake = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <path d="M5 8h3l2-3h4l2 3h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" />
    <path d="m7 13 2-2 2 4 2-5 2 4 2-2" />
  </IconBase>
);

export const IconTimelineCameraHitchcock = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <circle cx="12" cy="12" r="7" />
    <path d="M12 8v8M8 12h8" />
    <path d="M4 4h5M4 4v5M20 20h-5M20 20v-5" opacity="0.65" />
  </IconBase>
);

export const IconTimelineCameraReset = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <path d="M5 8h3l2-3h4l2 3h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" />
    <path d="M9 14a3 3 0 1 0 1-2.24" />
    <path d="M9 10v3h3" />
  </IconBase>
);

export const IconTimelineEnvironmentTransform = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <path d="M8 9h8M8 15h8" opacity="0.5" />
    <path d="M16 3h5v5M21 3l-6 6" />
  </IconBase>
);

export const IconTimelineEnvironmentLayerTransform = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <rect x="3" y="7" width="13" height="10" rx="2" />
    <path d="M7 4h13v10" />
    <path d="M16 3h5v5M21 3l-6 6" />
  </IconBase>
);

export const IconTimelineEnvironmentRemove = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <path d="M8 12h8" />
    <path d="M3 3l18 18" opacity="0.65" />
  </IconBase>
);

export const IconTimelineEnvironmentLayerRemove = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <rect x="3" y="7" width="13" height="10" rx="2" />
    <path d="M7 4h13v10" />
    <path d="M3 3l18 18" opacity="0.65" />
  </IconBase>
);

export const IconTimelineLighting = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
    <circle cx="12" cy="12" r="4" fill="currentColor" fillOpacity="0.14" />
  </IconBase>
);

export const IconTimelineRimLight = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <circle cx="10" cy="8" r="3" />
    <path d="M4 21v-1a6 6 0 0 1 12 0v1" />
    <path d="M18 5c2 2.2 2.5 5.2 1.2 8" />
    <path d="M21 4h-4v4" />
  </IconBase>
);

export const IconTimelineBlur = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <circle cx="9" cy="12" r="5" />
    <circle cx="15" cy="12" r="5" opacity="0.55" />
    <path d="M4 5h16M4 19h16" opacity="0.45" />
  </IconBase>
);

export const IconTimelineGodrays = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <circle cx="7" cy="7" r="3" fill="currentColor" fillOpacity="0.14" />
    <path d="M10 9l10 2M9 11l8 6M6 11l-2 9M11 6l9-2" />
  </IconBase>
);

export const IconTimelinePostProcessing = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M8 8h8M8 12h4M8 16h8" />
    <path d="M15 10l3-3M18 7v3M18 7h-3" opacity="0.65" />
  </IconBase>
);

export const IconTimelineColorOverlay = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <circle cx="10" cy="10" r="5" fill="currentColor" fillOpacity="0.1" />
    <circle cx="14" cy="14" r="5" />
    <path d="M5 19h14" opacity="0.55" />
  </IconBase>
);

export const IconTimelinePointLight = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <circle cx="12" cy="10" r="4" fill="currentColor" fillOpacity="0.14" />
    <path d="M12 2v3M4 10h3M17 10h3M6.3 4.3l2.1 2.1M15.6 6.4l2.1-2.1" />
    <path d="M9 18h6M10 22h4M9 14h6v4H9z" />
  </IconBase>
);

export const IconTimelineAudioPlay = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="m16 9 5 3-5 3V9Z" fill="currentColor" fillOpacity="0.18" />
  </IconBase>
);

export const IconTimelineAudioStop = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <rect x="16" y="9" width="5" height="6" rx="1" />
  </IconBase>
);

export const IconTimelineBgm = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <path d="M9 18V5l10-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="16" cy="16" r="3" />
  </IconBase>
);

export const IconTimelineImageAdd = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <rect x="3" y="5" width="14" height="14" rx="2" />
    <path d="m4 16 4-4 3 3 3-4 3 4" />
    <path d="M19 6v6M22 9h-6" />
  </IconBase>
);

export const IconTimelineTextAdd = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <path d="M4 6h10M9 6v14" />
    <path d="M18 12v6M21 15h-6" />
  </IconBase>
);

export const IconTimelineTextTransform = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <path d="M4 6h10M9 6v14" />
    <path d="M16 4h5v5M21 4l-6 6" />
    <path d="M17 20h-5v-5M12 20l6-6" />
  </IconBase>
);

export const IconTimelineTextRemove = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <path d="M4 6h10M9 6v14" />
    <path d="M16 15h6" />
  </IconBase>
);

export const IconTimelineCustomAnimation = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <path d="M13 2 4 14h7l-1 8 10-12h-7l1-8Z" fill="currentColor" fillOpacity="0.12" />
    <path d="M13 2 4 14h7l-1 8 10-12h-7l1-8Z" />
    <path d="M4 4h4M4 4v4M20 20h-4M20 20v-4" opacity="0.6" />
  </IconBase>
);

export const IconTimelineDefault = (props: IconProps) => (
  <IconBase strokeWidth="2.2" {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5" />
    <path d="M12 16h.01" />
  </IconBase>
);

// AI Identity & Global Feature Icons
export const IconSparkles = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M12 3c.5 3 2.5 5 5.5 5.5-3 .5-5 2.5-5.5 5.5-.5-3-2.5-5-5.5-5.5 3-.5 5-2.5 5.5-5.5Z" fill="currentColor" fillOpacity="0.12" />
    <path d="M12 3c.5 3 2.5 5 5.5 5.5-3 .5-5 2.5-5.5 5.5-.5-3-2.5-5-5.5-5.5 3-.5 5-2.5 5.5-5.5Z" />
    <path d="M19 16c.3 1.5 1.2 2.4 2.7 2.7-1.5.3-2.4 1.2-2.7 2.7-.3-1.5-1.2-2.4-2.7-2.7 1.5-.3 2.4-1.2 2.7-2.7Z" />
    <path d="M5 16c.3 1.2 1 2 2.2 2.2-1.2.3-1.9 1-2.2 2.2-.3-1.2-1-1.9-2.2-2.2 1.2-.2 1.9-.9 2.2-2.2Z" />
  </IconBase>
);

export const IconAgent = (props: IconProps) => (
  <IconBase {...props}>
    <ellipse cx="12" cy="12" rx="8.6" ry="5.4" transform="rotate(-45 12 12)" />
    <ellipse cx="12" cy="12" rx="8.6" ry="5.4" transform="rotate(45 12 12)" />
    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
  </IconBase>
);

export const IconThink = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M9.5 2A4.5 4.5 0 0 0 5 6.5c0 1.6.8 3 2 3.8V13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2.7c1.2-.8 2-2.2 2-3.8A4.5 4.5 0 0 0 14.5 2" />
    <path d="M9 17h6M10 20h4" />
    <path d="M12 6v3M10.5 7.5l3-3" opacity="0.6" />
  </IconBase>
);

export const IconTools = (props: IconProps) => (
  <IconBase {...props}>
    <path d="m14.7 6.3 3 3-9.4 9.4H5.3v-3l9.4-9.4Z" />
    <path d="m17 4 3 3-2 2-3-3 2-2Z" />
    <path d="M7 17 4 20" />
    <circle cx="18.5" cy="5.5" r="0.5" fill="currentColor" stroke="none" />
  </IconBase>
);

export const IconAiProse = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H15l5 5v12.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 19.5Z" />
    <path d="M14 2v5h5" />
    <path d="M8 13h5M8 17h4" />
    <path d="m18 13 1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z" fill="currentColor" stroke="none" />
  </IconBase>
);

export const IconPerformanceDirector = (props: IconProps) => (
  <IconBase {...props}>
    <rect x="3" y="5" width="18" height="15" rx="2" />
    <path d="m3 9 4-4M8 9l4-4M13 9l4-4M18 9l3-3" />
    <circle cx="9" cy="14" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="15" cy="14" r="1.5" fill="currentColor" stroke="none" />
    <path d="M8.5 17c1 1 2.5 1 3.5 1s2.5 0 3.5-1" />
  </IconBase>
);

export const IconCinematicMaster = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="m14.3 3.3-3.6 6.2M9.7 20.7l3.6-6.2M3.3 9.7l6.2 3.6M20.7 14.3l-6.2-3.6M7.5 4.8l-1.3 7M16.5 19.2l1.3-7" />
    <circle cx="12" cy="12" r="3" fill="currentColor" fillOpacity="0.15" />
  </IconBase>
);

// Agent Activity Stream Tool Icons
export const IconToolSceneRead = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M4 4v16a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8l-5-5H5a1 1 0 0 0-1 1Z" />
    <path d="M14 3v5h5" />
    <path d="M8 12h5M8 16h8" />
  </IconBase>
);

export const IconToolSceneSearch = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M13 3H5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8" />
    <circle cx="15.5" cy="8.5" r="3.5" />
    <path d="m18 11 3 3" />
    <path d="M8 12h3M8 16h8" />
  </IconBase>
);

export const IconToolSceneValidate = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M12 3s7 2 8 6c0 6-4.5 10.5-8 12-3.5-1.5-8-6-8-12 1-4 8-6 8-6Z" />
    <path d="m9 12 2 2 4-4" />
  </IconBase>
);

export const IconToolProjectOverview = (props: IconProps) => (
  <IconBase {...props}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
    <path d="M10 6.5h4M6.5 10v4M14 17.5h-4M17.5 10v4" opacity="0.4" />
  </IconBase>
);

export const IconToolProjectFiles = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M3 7v13a1 1 0 0 0 1 1h13" />
    <path d="M7 3h9l4 4v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
    <path d="M16 3v4h4" />
  </IconBase>
);

export const IconToolProjectText = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </IconBase>
);

export const IconToolProjectSearch = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 5 5" />
    <path d="M7.5 10.5h6M7.5 8h4" opacity="0.6" />
  </IconBase>
);

export const IconToolResourceSearch = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2.5-1.43" />
    <circle cx="16" cy="16" r="3" />
    <path d="m18.5 18.5 2.5 2.5" />
    <path d="M3.5 7.5 12 12m0 0 8.5-4.5M12 12v9" opacity="0.5" />
  </IconBase>
);

export const IconToolResourceInspect = (props: IconProps) => (
  <IconBase {...props}>
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
    <path d="M12 12v9M12 12 4 7.5M12 12l8-4.5" opacity="0.4" />
    <circle cx="12" cy="12" r="3" fill="currentColor" fillOpacity="0.2" />
    <path d="M9 12h6" />
  </IconBase>
);

export const IconToolVision = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3.5" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
  </IconBase>
);

export const IconToolTerminal = (props: IconProps) => (
  <IconBase {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </IconBase>
);

export const IconToolWrite = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M11 4H4a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1v-7" />
    <path d="m18.5 2.5 3 3L11 16H8v-3l10.5-10.5Z" />
  </IconBase>
);

export const IconToolCompaction = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M4 6h16M4 18h16" />
    <path d="m9 10 3 2 3-2M9 14l3-2 3 2" />
  </IconBase>
);

export const IconCheckCircle = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </IconBase>
);

export const IconAlertCircle = (props: IconProps) => (
  <IconBase {...props}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </IconBase>
);

export const IconAlertTriangle = (props: IconProps) => (
  <IconBase {...props}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </IconBase>
);

export const IconBell = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </IconBase>
);

export const IconMegaphone = (props: IconProps) => (
  <IconBase {...props}>
    <path d="m3 11 18-5v12L3 13v-2z" />
    <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
  </IconBase>
);

export const IconPin = (props: IconProps) => (
  <IconBase {...props}>
    <line x1="12" y1="17" x2="12" y2="22" />
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V5a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v5.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z" />
  </IconBase>
);

export const IconNewspaper = (props: IconProps) => (
  <IconBase {...props}>
    <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
    <path d="M18 14h-8" />
    <path d="M15 18h-5" />
    <path d="M10 6h8v4h-8V6Z" />
  </IconBase>
);


