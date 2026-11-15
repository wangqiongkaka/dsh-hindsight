import React from 'react';
export function Button({ variant, style, ...props }) {
  return <button {...props} style={{ padding: '8px 14px', minHeight: 36, borderRadius: 7, font: 'inherit', cursor: props.disabled ? 'default' : 'pointer', opacity: props.disabled ? .5 : 1, border: '1px solid #dce0e7', background: variant === 'primary' ? '#386bdd' : 'transparent', color: variant === 'primary' ? '#fff' : 'inherit', ...style }} />;
}
