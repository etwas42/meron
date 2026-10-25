import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useValue } from '@legendapp/state/react'
import { ChevronRight, Copy, FolderInput } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { accounts$, isSendableAccount } from '../../states/accounts'
import { mail$ } from '../../states/mail'
import { ensureAccountFolders } from '../../states/mailFolders'
import { copyThreadToFolder, moveThreadToFolder } from '../../states/mailMoves'
import { recentThreadTransfers$ } from '../../states/recentThreadTransfers'
import { FloatingContextMenu } from '../menu/FloatingContextMenu'
import { FolderMenuTree } from '../menu/FolderMenuTree'
import { MenuItem } from '../menu/MenuItem'

const MOVE_FLYOUT_WIDTH = 230
const COPY_FLYOUT_WIDTH = 230

// The flyouts are portalled out of the menu that opens them, so that menu's
// "click outside" check has to count them as inside: they carry this marker.
// Above every menu that hosts them, the conversation's overlay included.
const flyoutClass = 'fixed z-[62] max-h-[calc(100vh-1rem)] overflow-y-auto shadow-xl'

/** Where a flyout of `width` opens beside its menu row: to the right, or to the
 *  left when the window has no room there. Null while closed. */
function useFlyoutPosition(open: boolean, anchorRef: RefObject<HTMLDivElement | null>, width: number) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const anchor = anchorRef.current
    if (!anchor) return
    const gap = 4
    const rect = anchor.getBoundingClientRect()
    const x = rect.right + gap + width > window.innerWidth ? rect.left - width - gap : rect.right + gap
    const y = rect.top
    setPosition((current) => (current?.x === x && current.y === y ? current : { x, y }))
  }, [open, anchorRef, width])
  return position
}

/**
 * The "Move to" and "Copy to" rows of a mail thread's menu, each opening a
 * flyout of folders. Shared by the thread list's right-click menu and the open
 * conversation's actions menu, which style their rows differently — hence
 * `itemClassName` and `iconSize`.
 */
export function ThreadMoveCopyItems({
  threadId,
  accountId,
  folderId,
  close,
  onMove,
  onMoved,
  onCopied,
  itemClassName,
  iconSize = 13,
}: {
  threadId: string
  accountId: string
  folderId: string
  close: () => void
  // When provided, the move is delegated whole to the caller (e.g. the kanban
  // view's optimistic move-and-revert) instead of running the default one.
  onMove?: (threadId: string, targetAccountId: string, targetFolderId: string) => void
  onMoved?: (targetAccountId: string, targetFolderId: string) => void | Promise<void>
  onCopied?: (targetAccountId: string, targetFolderId: string) => void | Promise<void>
  itemClassName?: string
  iconSize?: number
}) {
  const { t } = useTranslation()
  const foldersByAccount = useValue(mail$.foldersByAccount)
  const accounts = useValue(accounts$)
  const recentTransfers = useValue(recentThreadTransfers$)
  const mailAccounts = accounts.filter(isSendableAccount)
  const [moveOpen, setMoveOpen] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  const [copyLoading, setCopyLoading] = useState(false)
  const [, setCopyFoldersVersion] = useState(0)
  const moveAnchorRef = useRef<HTMLDivElement | null>(null)
  const copyAnchorRef = useRef<HTMLDivElement | null>(null)
  const copyLoadRef = useRef(false)
  const moveFlyoutPosition = useFlyoutPosition(moveOpen, moveAnchorRef, MOVE_FLYOUT_WIDTH)
  const copyFlyoutPosition = useFlyoutPosition(copyOpen, copyAnchorRef, COPY_FLYOUT_WIDTH)

  const loadCopyTargetFolders = async () => {
    if (copyLoadRef.current) return
    copyLoadRef.current = true
    setCopyLoading(true)
    try {
      await Promise.all(
        mailAccounts.map((account) =>
          ensureAccountFolders(account.id, { refreshIfBootstrapOnly: true, waitForRefresh: true }),
        ),
      )
    } finally {
      copyLoadRef.current = false
      setCopyLoading(false)
      setCopyFoldersVersion((version) => version + 1)
    }
  }

  // Reset the flyouts each time the menu turns to another thread, and make
  // sure the thread's account folders are loaded — in the unified view they
  // aren't part of the selected account's `mail$.folders`.
  useEffect(() => {
    setMoveOpen(false)
    setCopyOpen(false)
    if (accountId) void ensureAccountFolders(accountId)
  }, [accountId, threadId])

  useEffect(() => {
    if (!copyOpen && !moveOpen) return
    void loadCopyTargetFolders()
  }, [accounts, copyOpen, moveOpen])

  useEffect(() => {
    const targetAccounts = new Set(
      recentTransfers.filter((entry) => entry.sourceAccountId === accountId).map((entry) => entry.targetAccountId),
    )
    for (const targetAccountId of targetAccounts) {
      if (
        targetAccountId !== accountId &&
        accounts.some((account) => account.id === targetAccountId && isSendableAccount(account))
      ) {
        void ensureAccountFolders(targetAccountId)
      }
    }
  }, [accountId, accounts, recentTransfers])

  const canMove = mailAccounts.length > 0
  const copyAccountGroups = mailAccounts.map((account) => ({
    account,
    folders: foldersByAccount[account.id] ?? [],
    // The thread's own folder stays in the tree as a parent, just not pickable.
    excluded: account.id === accountId ? [folderId] : [],
  }))
  const recentItems = recentTransfers
    .flatMap((entry) => {
      if (entry.sourceAccountId !== accountId) return []
      if (
        entry.targetAccountId === accountId &&
        (entry.targetFolderId === folderId ||
          (entry.targetFolderId.toUpperCase() === 'INBOX' && folderId.toUpperCase() === 'INBOX'))
      )
        return []
      const account = mailAccounts.find((account) => account.id === entry.targetAccountId)
      const folder = foldersByAccount[entry.targetAccountId]?.find((folder) => folder.id === entry.targetFolderId)
      if (!account || !folder) return []
      return [{ entry, account, folder }]
    })
    .slice(0, 2)

  const moveTo = (targetAccountId: string, targetFolderId: string) => {
    close()
    if (onMove) {
      onMove(threadId, targetAccountId, targetFolderId)
      return
    }
    void moveThreadToFolder(threadId, targetFolderId, { targetAccountId }).then((moved) => {
      if (moved) return onMoved?.(targetAccountId, targetFolderId)
    })
  }

  const copyTo = (targetAccountId: string, targetFolderId: string) => {
    close()
    void copyThreadToFolder(threadId, targetAccountId, targetFolderId).then(() =>
      onCopied?.(targetAccountId, targetFolderId),
    )
  }

  return (
    <>
      {canMove && (
        <div
          ref={moveAnchorRef}
          onMouseEnter={() => {
            setCopyOpen(false)
            setMoveOpen(true)
          }}
          onMouseLeave={() => setMoveOpen(false)}
        >
          <MenuItem
            icon={<FolderInput size={iconSize} className="shrink-0 text-secondary" />}
            label={t('threads.actions.moveTo')}
            submenuOpen={moveOpen}
            trailing={<ChevronRight size={13} className="text-secondary" />}
            className={itemClassName}
            onClick={() => setMoveOpen((open) => !open)}
          />
          {moveOpen && moveFlyoutPosition && (
            <FloatingContextMenu
              x={moveFlyoutPosition.x}
              y={moveFlyoutPosition.y}
              className={`${flyoutClass} min-w-[230px]`}
              dataAttribute="data-thread-context-menu"
            >
              {copyAccountGroups.map(({ account, folders, excluded }) => (
                <div key={account.id}>
                  <div className="px-3 pb-1 pt-2 text-[0.6875rem] font-semibold text-secondary">
                    {account.display_name || account.email || account.id}
                  </div>
                  {folders.length === 0 && (
                    <div className="px-3 py-2 text-xs font-semibold text-secondary">
                      {copyLoading ? t('folders.loading') : t('folders.noneAvailable')}
                    </div>
                  )}
                  <FolderMenuTree
                    folders={folders}
                    excludedFolderIds={excluded}
                    onPick={(folder) => moveTo(account.id, folder.id)}
                  />
                </div>
              ))}
            </FloatingContextMenu>
          )}
        </div>
      )}
      {mailAccounts.length > 0 && (
        <div
          ref={copyAnchorRef}
          onMouseEnter={() => {
            setMoveOpen(false)
            setCopyOpen(true)
            void loadCopyTargetFolders()
          }}
          onMouseLeave={() => setCopyOpen(false)}
        >
          <MenuItem
            icon={<Copy size={iconSize} className="shrink-0 text-secondary" />}
            label={t('threads.actions.copyTo')}
            submenuOpen={copyOpen}
            trailing={<ChevronRight size={13} className="text-secondary" />}
            className={itemClassName}
            onClick={() => {
              setCopyOpen((open) => !open)
              void loadCopyTargetFolders()
            }}
          />
          {copyOpen && copyFlyoutPosition && (
            <FloatingContextMenu
              x={copyFlyoutPosition.x}
              y={copyFlyoutPosition.y}
              className={`${flyoutClass} min-w-[230px]`}
              dataAttribute="data-thread-context-menu"
            >
              {copyAccountGroups.map(({ account, folders, excluded }) => (
                <div key={account.id}>
                  <div className="px-3 pb-1 pt-2 text-[0.6875rem] font-semibold text-secondary">
                    {account.display_name || account.email || account.id}
                  </div>
                  {folders.length === 0 && (
                    <div className="px-3 py-2 text-xs font-semibold text-secondary">
                      {copyLoading ? t('folders.loading') : t('folders.noneAvailable')}
                    </div>
                  )}
                  <FolderMenuTree
                    folders={folders}
                    excludedFolderIds={excluded}
                    onPick={(folder) => {
                      copyTo(account.id, folder.id)
                    }}
                  />
                </div>
              ))}
            </FloatingContextMenu>
          )}
        </div>
      )}
      {recentItems.length > 0 && <div className="my-1 border-t border-border" />}
      {recentItems.map(({ entry, account, folder }) => {
        const destination =
          entry.targetAccountId === accountId
            ? folder.name
            : `${account.display_name || account.email || account.id} / ${folder.name}`
        const label = t(entry.action === 'move' ? 'threads.actions.moveToRecent' : 'threads.actions.copyToRecent', {
          folder: destination,
          defaultValue: entry.action === 'move' ? 'Move to “{folder}”' : 'Copy to “{folder}”',
        })
        const Icon = entry.action === 'move' ? FolderInput : Copy
        return (
          <MenuItem
            key={`${entry.action}:${entry.targetAccountId}:${entry.targetFolderId}`}
            icon={<Icon size={iconSize} className="shrink-0 text-secondary" />}
            label={
              <span className="min-w-0 max-w-[280px] truncate" title={label}>
                {label}
              </span>
            }
            className={itemClassName}
            onClick={() =>
              entry.action === 'move'
                ? moveTo(entry.targetAccountId, entry.targetFolderId)
                : copyTo(entry.targetAccountId, entry.targetFolderId)
            }
          />
        )
      })}
    </>
  )
}
