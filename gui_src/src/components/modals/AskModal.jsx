import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageCircleQuestion } from 'lucide-react';

import FloatingAgentWindow from '../FloatingAgentWindow';
import { askQuestionOptions, formatAskResponse } from '../../utils/askQuestion';

const RECT_STORAGE_KEY = 'askQuestionWindowRect';
const COLLAPSED_STORAGE_KEY = 'askQuestionWindowCollapsed';

// Kept under the historical AskModal name at the import boundary, but rendered
// as a non-modal floating window so the workbench remains usable while the
// agent waits for the answer.
export default function AskModal({ askRequest, onConfirm }) {
  const { t } = useTranslation();
  const hasProvidedOptions = Array.isArray(askRequest?.options) && askRequest.options.length > 0;
  const options = askQuestionOptions(askRequest?.options);
  const isMultiSelect = Boolean(askRequest?.is_multi_select && options);
  const [inputValue, setInputValue] = useState(() => (
    hasProvidedOptions ? '' : String(askRequest?.default || '')
  ));
  const [selectedIndexes, setSelectedIndexes] = useState(() => (
    options && !isMultiSelect ? new Set([0]) : new Set()
  ));
  const [isOtherSelected, setIsOtherSelected] = useState(() => !options);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!options) inputRef.current?.focus();
  }, [options]);

  if (!askRequest) return null;

  const toggleOption = (index) => {
    if (!isMultiSelect) {
      setSelectedIndexes(new Set([index]));
      setIsOtherSelected(false);
      return;
    }
    setSelectedIndexes((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const selectOther = () => {
    if (isMultiSelect) {
      setIsOtherSelected((previous) => {
        const next = !previous;
        if (next) setTimeout(() => inputRef.current?.focus(), 0);
        return next;
      });
      return;
    }
    setSelectedIndexes(new Set());
    setIsOtherSelected(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const responseValue = () => formatAskResponse({
    inputValue,
    isMultiSelect,
    isOtherSelected,
    options,
    selectedIndexes,
  });

  const canSubmit = options
    ? selectedIndexes.size > 0 || (isOtherSelected && inputValue.trim().length > 0)
    : inputValue.trim().length > 0;

  const submitResponse = async (value) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onConfirm(value);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (event) => {
    event?.preventDefault();
    if (!canSubmit || isSubmitting) return;
    await submitResponse(responseValue());
  };

  return (
    <FloatingAgentWindow
      className="ask-window"
      rectStorageKey={RECT_STORAGE_KEY}
      collapsedStorageKey={COLLAPSED_STORAGE_KEY}
      icon={<MessageCircleQuestion size={15} />}
      title={t('askModal.title', 'Input Required')}
      waitingLabel={t('askModal.waiting', 'Waiting for your answer')}
      dragHint={t('askModal.dragHint', 'Drag to move this window')}
      resizeHint={t('askModal.resizeHint', 'Drag to resize this window')}
      collapseLabel={t('askModal.collapse', 'Collapse to title bar')}
      expandLabel={t('askModal.expand', 'Expand')}
    >
      <form className="ask-window-form" onSubmit={handleSubmit}>
        <p className="plan-window-prompt ask-window-prompt">{askRequest.prompt}</p>

        <div className="ask-window-body">
          {options && (
            <fieldset className="ask-window-options">
              <legend>
                {isMultiSelect
                  ? t('askModal.optionsTitleMultiple', 'Select one or more options:')
                  : t('askModal.optionsTitle', 'Select an option:')}
              </legend>
              {options.map((option, index) => {
                const isSelected = selectedIndexes.has(index);
                return (
                  <label
                    key={`${index}-${option}`}
                    className={`ask-window-option${isSelected ? ' is-selected' : ''}`}
                  >
                    <input
                      type={isMultiSelect ? 'checkbox' : 'radio'}
                      name={isMultiSelect ? `ask-option-${index}` : 'ask-option'}
                      checked={isSelected}
                      onChange={() => toggleOption(index)}
                    />
                    <span>{option}</span>
                  </label>
                );
              })}

              <label className={`ask-window-option${isOtherSelected ? ' is-selected' : ''}`}>
                <input
                  type={isMultiSelect ? 'checkbox' : 'radio'}
                  name={isMultiSelect ? 'ask-option-other' : 'ask-option'}
                  checked={isOtherSelected}
                  onChange={selectOther}
                />
                <span>{t('askModal.otherOption', 'Other (write in below)')}</span>
              </label>
            </fieldset>
          )}

          {(!options || isOtherSelected) && (
            <textarea
              ref={inputRef}
              className="ask-window-input"
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  handleSubmit(event);
                }
              }}
              placeholder={options
                ? t('askModal.otherPlaceholder', 'Describe what you want…')
                : t('askModal.placeholder', 'Type your answer here…')}
              rows={options ? 2 : (askRequest.rows || 3)}
              aria-label={options
                ? t('askModal.otherInputLabel', 'Custom response')
                : t('askModal.answerInputLabel', 'Answer')}
            />
          )}
        </div>

        <div className="plan-window-footer ask-window-footer">
          <button
            type="button"
            className="vscode-button plan-window-reject"
            onClick={() => submitResponse('')}
            disabled={isSubmitting}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button type="submit" className="vscode-button" disabled={!canSubmit || isSubmitting}>
            {t('askModal.send', 'Send')}
          </button>
        </div>
      </form>
    </FloatingAgentWindow>
  );
}
