import type { ReactElement } from 'react'
import { useState } from 'react'

export default function HomePage(): ReactElement {
  const [count, setCount] = useState(0)
  const base = import.meta.env.BASE_URL

  return (
    <main>
      <h1>React multi-page example</h1>
      <nav aria-label="Pages">
        <a href={`${base}hello-world.html`}>Hello World</a>
        {' · '}
        <a href={`${base}admin/users.html`}>Users</a>
      </nav>
      <button type="button" onClick={() => setCount(count + 1)}>
        Count:
        {' '}
        {count}
      </button>
    </main>
  )
}
