/**
 * Numeric inbox unread-count badge overlaid on the top-right of a side navigation avatar
 * or button. Caps at "99+". Renders nothing when count is 0.
 */
export function UnreadCountBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="pointer-events-none absolute -top-1 -right-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-unread-rail-bg px-1.5 text-[0.625rem] font-semibold leading-none text-unread-rail-text ring-2 ring-sidenav">
      {count > 99 ? '99+' : count}
    </span>
  )
}
