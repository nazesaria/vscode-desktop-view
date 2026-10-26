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
}

/**
 * A selectable list driven by the keyboard the way GitHub Desktop's lists are:
 * arrow keys move the selection, Home/End jump, PageUp/PageDown skip a page.
 */
export function List<T>(props: ListProps<T>) {
  const { items, getKey, selectedKey, onSelect } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const selectedIndex = selectedKey === null ? -1 : items.findIndex(i => getKey(i) === selectedKey)

  useEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
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
      onSelect(items[next])
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
      {items.map(item => {
        const key = getKey(item)
        const selected = key === selectedKey
        const context = props.getContext?.(item)
        return (
          <div
            key={key}
            role="option"
            aria-selected={selected}
            className={`list-row ${props.rowClassName ?? ''} ${selected ? 'selected' : ''}`}
            onMouseDown={() => onSelect(item)}
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
