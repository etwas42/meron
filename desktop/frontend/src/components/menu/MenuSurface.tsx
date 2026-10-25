import type { ComponentProps } from 'react'
import { clsx } from '../../lib/utils'

/** Shared, animation-free surface for positioned menus and their flyouts. */
export function MenuSurface({ className, ref, ...props }: ComponentProps<'div'>) {
  return <div {...props} ref={ref} className={clsx('menu-surface', className)} />
}
