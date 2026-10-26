import React, { useEffect, useRef } from 'react'

interface ListProps<T> {
  items: ReadonlyArray<T>
  getKey: (item: T) => string
  selectedKey: string | null
  onSelect: (item: T) => void
  renderItem: (item: T, selected: boolean) => React.ReactNode
  rowClassName?: string
  /** `data-vscode-context` payload for each row, enabling the native context menu. */
  getContext?: (item: T) => object
  onActivate?: (item: T) => void
  onEndReached?: () => void
  emptyText?: React.ReactNode
  className?: string
  ariaLabel: string
  /**
   * Enables multi-selection (Ctrl/Cmd+click, Shift+click, Shift+arrows).
   * `selectedKey` is then the focused item among these.
   */
  multiSelectedKeys?: ReadonlyArray<string>
  onMultiSelect?: (items: T[], focus: T) => void
}

/**
 * A selectable list driven by the keyboard the way GitHub Desktop's lists are:
 * arrow keys move the selection, Home/End jump, PageUp/PageDown skip a page.
 */
export function List<T>(props: ListProps<T>) {
  const { items, getKey, selectedKey, onSelect } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const anchor = useRef<string | null>(null)
  const selectedIndex = selectedKey === null ? -1 : items.findIndex(i => getKey(i) === selectedKey)
  const multi = props.onMultiSelect !== undefined
  const selectedSet = new Set(props.multiSelectedKeys ?? (selectedKey === null ? [] : [selectedKey]))

  const selectSingle = (item: T) => {
    anchor.current = getKey(item)
    onSelect(item)
  }
  const selectRange = (to: number) => {
    const anchorIndex = Math.max(0, items.findIndex(i => getKey(i) === (anchor.current ?? selectedKey)))
    const [a, b] = anchorIndex <= to ? [anchorIndex, to] : [to, anchorIndex]
    props.onMultiSelect!(items.slice(a, b + 1), items[to])
  }
  const onRowMouseDown = (e: React.MouseEvent, item: T, index: number) => {
    if (multi && e.shiftKey) {
      e.preventDefault()
      selectRange(index)
    } else if (multi && (e.ctrlKey || e.metaKey)) {
      const key = getKey(item)
      const keys = new Set(selectedSet)
      if (keys.has(key)) {
        keys.delete(key)
      } else {
        keys.add(key)
      }
      const chosen = items.filter(i => keys.has(getKey(i)))
      if (chosen.length > 0) {
        anchor.current = key
        props.onMultiSelect!(chosen, keys.has(key) ? item : chosen[0])
      }
    } else if (e.button === 0 || !selectedSet.has(getKey(item))) {
      // A right click on a selected row keeps the selection for the context menu.
      selectSingle(item)
    }
  }

  useEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>('[data-focused="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedKey])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (items.length === 0) {
      return
    }
    const pageSize = Math.max(1, Math.floor((containerRef.current?.clientHeight ?? 300) / 40))
    let next = selectedIndex
    switch (e.key) {
      case 'ArrowDown':
        next = Math.min(items.length - 1, selectedIndex + 1)
        break
      case 'ArrowUp':
        next = Math.max(0, selectedIndex - 1)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = items.length - 1
        break
      case 'PageDown':
        next = Math.min(items.length - 1, selectedIndex + pageSize)
        break
      case 'PageUp':
        next = Math.max(0, selectedIndex - pageSize)
        break
      case 'Enter':
        if (selectedIndex >= 0) {
          props.onActivate?.(items[selectedIndex])
        }
        e.preventDefault()
        return
      default:
        return
    }
    e.preventDefault()
    if (next !== selectedIndex && next >= 0) {
      if (multi && e.shiftKey) {
        selectRange(next)
      } else {
        selectSingle(items[next])
      }
    }
  }

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (props.onEndReached && el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
      props.onEndReached()
    }
  }

  return (
    <div
      ref={containerRef}
      className={`list ${props.className ?? ''}`}
      role="listbox"
      aria-label={props.ariaLabel}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={onScroll}
    >
      {items.length === 0 && props.emptyText ? <div className="list-empty">{props.emptyText}</div> : null}
      {items.map((item, index) => {
        const key = getKey(item)
        const selected = selectedSet.has(key)
        const context = props.getContext?.(item)
        return (
          <div
            key={key}
            role="option"
            aria-selected={selected}
            data-focused={key === selectedKey}
            className={`list-row ${props.rowClassName ?? ''} ${selected ? 'selected' : ''}`}
            onMouseDown={e => onRowMouseDown(e, item, index)}
            onDoubleClick={() => props.onActivate?.(item)}
            data-vscode-context={
              context ? JSON.stringify({ ...context, preventDefaultContextMenuItems: true }) : undefined
            }
          >
            {props.renderItem(item, selected)}
          </div>
        )
      })}
    </div>
  )
}
