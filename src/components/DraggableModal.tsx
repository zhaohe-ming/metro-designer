import React, { useEffect, useRef, useState } from 'react';
import { Modal } from 'antd';
import type { ModalProps } from 'antd';

const DraggableModal: React.FC<ModalProps> = ({ title, open, modalRender, className, rootClassName, ...rest }) => {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0 });
  const originRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      setOffset({
        x: originRef.current.x + (e.clientX - startRef.current.x),
        y: originRef.current.y + (e.clientY - startRef.current.y)
      });
    };

    const handleMouseUp = () => {
      draggingRef.current = false;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setOffset({ x: 0, y: 0 });
    }
  }, [open]);

  const handleTitleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    startRef.current = { x: e.clientX, y: e.clientY };
    originRef.current = { ...offset };
  };

  const draggableTitle = title ? (
    <div className="metro-modal-title" onMouseDown={handleTitleMouseDown}>
      <span className="metro-modal-title__text">{title}</span>
    </div>
  ) : title;

  const mergedModalRender = (node: React.ReactNode) => {
    const wrapped = <div style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>{node}</div>;
    return modalRender ? modalRender(wrapped) : wrapped;
  };

  return (
    <Modal
      {...rest}
      open={open}
      title={draggableTitle}
      modalRender={mergedModalRender}
      className={className}
      rootClassName={['metro-modal-root', rootClassName].filter(Boolean).join(' ')}
    />
  );
};

export default DraggableModal;
