// Matches model-provided "other"/"none of the above" style choices (en/pt/es).
// The UI owns one write-in option, so equivalent model choices are removed.
const OTHER_OPTION_PATTERN = /^(outr[oa]s?|other|otro)\b/i;

export const askQuestionOptions = (options) => {
  if (!Array.isArray(options) || options.length === 0) return null;
  const filtered = options.filter((option) => !OTHER_OPTION_PATTERN.test(String(option).trim()));
  return filtered.length > 0 ? filtered : null;
};

/**
 * Apply defaults according to the request contract. Ask requests must never
 * inherit the yes/no choices or the affirmative default used by confirmations.
 */
export const normalizeInputRequest = (data = {}) => {
  const type = data.type || 'confirm';
  const request = { ...data, id: data.id, prompt: data.prompt, type };

  if (data.options === undefined || data.options === null) {
    if (type !== 'ask') request.options = ['yes', 'no'];
    else delete request.options;
  }
  if (data.default === undefined || data.default === null) {
    if (type !== 'ask') request.default = 'yes';
    else delete request.default;
  }
  return request;
};

/** Return the wire value expected by /api/opalatex/input_response. */
export const formatAskResponse = ({
  inputValue = '',
  isMultiSelect = false,
  isOtherSelected = false,
  options,
  selectedIndexes = [],
}) => {
  if (!options || options.length === 0) return inputValue;

  if (!isMultiSelect) {
    if (isOtherSelected) return inputValue;
    const [selectedIndex] = selectedIndexes;
    return Number.isInteger(selectedIndex) && options[selectedIndex] !== undefined
      ? String(options[selectedIndex])
      : '';
  }

  const selected = [...selectedIndexes]
    .filter((index) => Number.isInteger(index) && options[index] !== undefined)
    .sort((left, right) => left - right)
    .map((index) => String(options[index]));
  const custom = inputValue.trim();
  if (isOtherSelected && custom) selected.push(custom);
  return JSON.stringify(selected);
};
