import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function ReviewFixture() {
  const [count, setCount] = useState(0);
  const [compact, setCompact] = useState(false);
  return (
    <main className={compact ? 'compact' : ''}>
      <header>
        <div><small>Quarterly Operations</small><h1>Fleet performance dashboard</h1></div>
        <button onClick={() => setCompact(value => !value)}>Toggle density</button>
      </header>
      <section className="metrics">
        <article><span>On-time</span><strong>91.4%</strong></article>
        <article><span>Passengers</span><strong>18,204</strong></article>
        <article id="reactive-card"><span>Interactions</span><strong>{count}</strong><button onClick={() => setCount(value => value + 1)}>Increment React state</button></article>
      </section>
      <label>Reviewer note<textarea placeholder="Select this field with the extension picker" /></label>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<ReviewFixture />);
