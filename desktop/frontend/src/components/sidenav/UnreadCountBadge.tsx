/**
 * Numeric inbox unread-count badge overlaid on the top-right of a side navigation avatar
 * or button. Caps at "9999+". Renders nothing when count is 0.
 */
export function UnreadCountBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="pointer-events-none absolute -top-1 -right-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-accent-badge px-1.5 text-[0.625rem] font-semibold leading-none text-white ring-2 ring-sidenav">
      {count > 9999 ? '9999+' : count}
    </span>
  )
}
