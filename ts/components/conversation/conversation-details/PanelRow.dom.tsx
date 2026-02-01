// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import React from 'react';
import classNames from 'classnames';
import { bemGenerator } from './util.std.js';

export type Props = {
  alwaysShowActions?: boolean;
  className?: string;
  disabled?: boolean;
  icon?: React.ReactNode;
  label: string | React.ReactNode;
  info?: string | React.ReactNode;
  right?: string | React.ReactNode;
  actions?: React.ReactNode;
  onClick?: () => void;
};

const bem = bemGenerator('ConversationDetails-panel-row');

export const PanelRow = React.forwardRef<HTMLButtonElement, Props>(
  function PanelRowInner(
    {
      alwaysShowActions,
      className,
      disabled,
      icon,
      label,
      info,
      right,
      actions,
      onClick,
    }: Props,
    ref: React.Ref<HTMLButtonElement>
  ) {
    const mainContent = (
      <>
        {icon !== undefined ? <div className={bem('icon')}>{icon}</div> : null}
        <div className={bem('label')}>
          <div>{label}</div>
          {info !== undefined ? (
            <div className={bem('info')}>{info}</div>
          ) : null}
        </div>
        {right !== undefined ? (
          <div className={bem('right')}>{right}</div>
        ) : null}
      </>
    );

    const actionsContent =
      actions !== undefined ? (
        <div className={alwaysShowActions ? '' : bem('actions')}>
          {actions}
        </div>
      ) : null;

    if (onClick) {
      // When we have both onClick and actions, render actions outside the
      // button to avoid invalid DOM nesting (e.g. ContextMenu renders a button).
      if (actionsContent) {
        return (
          <div className={classNames(bem('root', 'button'), className)}>
            <button
              disabled={disabled}
              type="button"
              className={bem('root', 'button-inner')}
              onClick={onClick}
              ref={ref}
            >
              {mainContent}
            </button>
            {actionsContent}
          </div>
        );
      }
      return (
        <button
          disabled={disabled}
          type="button"
          className={classNames(bem('root', 'button'), className)}
          onClick={onClick}
          ref={ref}
        >
          {mainContent}
          {actionsContent}
        </button>
      );
    }

    return (
      <div className={classNames(bem('root'), className)}>
        {mainContent}
        {actionsContent}
      </div>
    );
  }
);
