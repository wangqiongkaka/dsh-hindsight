import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apply } from '../../src/client.jsx';

const sections = [];
apply({
  effect: setup => setup(),
  locale: { register: () => () => {} },
  slots: {
    inject(name, setup) {
      if (name !== 'settings.section') throw new Error('Hindsight 应只注册到设置');
      return setup();
    },
    register(options, component) {
      sections.push({ options, component });
      return () => sections.splice(0);
    },
  },
});
if (sections.length !== 1 || sections[0].options.id !== 'dsh-hindsight') throw new Error('设置入口注册异常');

function Preview() {
  const [active, setActive] = useState(false);
  const { options, component: Section } = sections[0];
  return <div aria-label="设置">
    <header style={{ marginBottom: 24, borderBottom: '1px solid #484848', paddingBottom: 16 }}>
      <h1 style={{ margin: '0 0 16px', font: '600 22px system-ui' }}>设置</h1>
      <nav aria-label="设置分类"><button type="button" aria-current={active ? 'page' : undefined} onClick={() => setActive(true)}
        style={{ padding: '8px 14px', background: active ? '#333' : 'transparent', color: 'inherit', border: '1px solid #777', borderRadius: 7 }}>{options.label()}</button></nav>
    </header>
    {active && <Section />}
  </div>;
}
createRoot(document.getElementById('app')).render(<Preview />);
