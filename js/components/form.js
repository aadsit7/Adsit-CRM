// ============================================
// Dynamic Form Builder
// ============================================

import { el } from '../utils/dom.js';

/**
 * Normalize any date string to YYYY-MM-DD format for HTML date inputs.
 * Handles ISO dates, US dates (M/D/YYYY), and other formats parseable by Date().
 */
function toISODateString(str) {
  if (!str) return '';
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // Strip time portion if present (e.g. "2026-04-10T00:00:00")
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) return str.split('T')[0];
  // Try parsing with Date constructor (handles "4/29/2026", "April 29, 2026", etc.)
  const d = new Date(str);
  if (isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Build a form from field definitions.
 * @param {Array} fields - Array of field configs
 * @param {Function} onSubmit - Called with form data object
 * @param {Object} initialValues - Pre-fill values
 * @returns {HTMLFormElement}
 */
export function buildForm(fields, onSubmit, initialValues = {}) {
  const form = el('form', { class: 'form', onSubmit: (e) => {
    e.preventDefault();
    const data = getFormData(form, fields);
    if (validateForm(form, fields, data)) {
      onSubmit(data);
    }
  }});

  let currentRow = null;

  fields.forEach((field, idx) => {
    if (field.type === 'row-start') {
      currentRow = el('div', { class: 'form-row' });
      return;
    }
    if (field.type === 'row-end') {
      if (currentRow) {
        form.appendChild(currentRow);
        currentRow = null;
      }
      return;
    }

    const group = createFormGroup(field, initialValues[field.name]);

    if (currentRow) {
      currentRow.appendChild(group);
    } else {
      form.appendChild(group);
    }
  });

  // Close any open row
  if (currentRow) form.appendChild(currentRow);

  return form;
}

/**
 * Build iOS/mobile-friendly input attributes based on field type & name.
 * These are no-ops on desktop but prevent iPhone Chrome quirks:
 *  - inputmode surfaces the right keyboard (numeric/email/tel/url)
 *  - autocapitalize/autocorrect avoid capitalizing emails/urls mid-stream
 */
function getMobileInputAttrs(field) {
  const attrs = {};
  const type = field.type || 'text';
  if (type === 'email') {
    attrs.inputmode = 'email';
    attrs.autocapitalize = 'off';
    attrs.autocorrect = 'off';
    attrs.spellcheck = 'false';
  } else if (type === 'tel') {
    attrs.inputmode = 'tel';
  } else if (type === 'url') {
    attrs.inputmode = 'url';
    attrs.autocapitalize = 'off';
    attrs.autocorrect = 'off';
    attrs.spellcheck = 'false';
  } else if (type === 'number') {
    attrs.inputmode = 'decimal';
  } else if (type === 'text' || !type) {
    // Proper-name-ish fields: capitalize each word
    if (field.name && /name|company|title|contact/i.test(field.name)) {
      attrs.autocapitalize = 'words';
    }
  }
  if (field.inputmode) attrs.inputmode = field.inputmode;
  return attrs;
}

function createFormGroup(field, initialValue) {
  const group = el('div', { class: 'form-group' });
  const value = initialValue ?? field.default ?? '';
  const mobileAttrs = getMobileInputAttrs(field);

  if (field.label) {
    group.appendChild(
      el('label', { class: 'form-label', for: `field-${field.name}` },
        field.label,
        field.required ? el('span', { style: { color: 'var(--color-danger)', marginLeft: '2px' } }, '*') : null
      )
    );
  }

  let input;

  switch (field.type) {
    case 'select': {
      // If the current value isn't in the options, add it so the form shows the correct value
      const optionsList = [...field.options];
      if (value) {
        const valueStr = String(value);
        const exists = optionsList.some(opt =>
          (typeof opt === 'string' ? opt : opt.value) === valueStr
        );
        if (!exists) {
          optionsList.unshift({ value: valueStr, label: valueStr });
        }
      }

      input = el('select', {
        class: 'form-select',
        id: `field-${field.name}`,
        name: field.name,
      },
        field.placeholder ? el('option', { value: '', disabled: true }, field.placeholder) : null,
        ...optionsList.map(opt => {
          const optValue = typeof opt === 'string' ? opt : opt.value;
          const optLabel = typeof opt === 'string' ? opt : opt.label;
          return el('option', { value: optValue }, optLabel);
        })
      );
      // Set value via property after options are appended for reliable pre-selection
      if (value) {
        input.value = String(value);
      } else if (field.placeholder) {
        input.selectedIndex = 0;
      }
      break;
    }

    case 'textarea':
      input = el('textarea', {
        class: 'form-textarea',
        id: `field-${field.name}`,
        name: field.name,
        placeholder: field.placeholder || '',
      }, String(value));
      break;

    case 'date':
      input = el('input', {
        class: 'form-input',
        type: 'date',
        id: `field-${field.name}`,
        name: field.name,
      });
      // Normalize to YYYY-MM-DD (HTML date inputs only accept this format)
      if (value) {
        const normalized = toISODateString(String(value));
        if (normalized) input.value = normalized;
      }
      break;

    case 'number':
      input = el('input', {
        class: 'form-input',
        type: 'number',
        id: `field-${field.name}`,
        name: field.name,
        placeholder: field.placeholder || '',
        min: field.min,
        step: field.step || 'any',
        ...mobileAttrs,
      });
      if (value !== '' && value !== undefined) input.value = String(value);
      break;

    default: // text, email, tel, url
      input = el('input', {
        class: 'form-input',
        type: field.type || 'text',
        id: `field-${field.name}`,
        name: field.name,
        placeholder: field.placeholder || '',
        ...mobileAttrs,
      });
      if (value !== '' && value !== undefined) input.value = String(value);
  }

  group.appendChild(input);
  group.appendChild(el('div', { class: 'form-error', id: `error-${field.name}` }));

  return group;
}

function getFormData(form, fields) {
  const data = {};
  fields.forEach(f => {
    if (f.type === 'row-start' || f.type === 'row-end') return;
    const input = form.querySelector(`[name="${f.name}"]`);
    if (input) {
      data[f.name] = input.value.trim();
    }
  });
  return data;
}

function validateForm(form, fields, data) {
  let valid = true;

  fields.forEach(f => {
    if (f.type === 'row-start' || f.type === 'row-end') return;

    const errEl = form.querySelector(`#error-${f.name}`);
    const input = form.querySelector(`[name="${f.name}"]`);

    if (errEl) errEl.textContent = '';
    if (input) input.classList.remove('form-input--error');

    if (f.required && !data[f.name]) {
      if (errEl) errEl.textContent = `${f.label || f.name} is required`;
      if (input) input.classList.add('form-input--error');
      valid = false;
    }
  });

  return valid;
}
