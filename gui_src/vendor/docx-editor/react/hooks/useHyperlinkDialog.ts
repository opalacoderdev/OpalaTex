import { useCallback, useState } from 'react';

export interface HyperlinkData {
  url: string;
  displayText?: string;
  tooltip?: string;
  anchor?: string;
}

export interface UseHyperlinkDialogState {
  isOpen: boolean;
  initialData?: HyperlinkData;
  selectedText?: string;
  isEditing: boolean;
}

export interface UseHyperlinkDialogReturn {
  state: UseHyperlinkDialogState;
  openInsert: (selectedText?: string) => void;
  openEdit: (data: HyperlinkData) => void;
  close: () => void;
  toggle: () => void;
}

export function useHyperlinkDialog(): UseHyperlinkDialogReturn {
  const [state, setState] = useState<UseHyperlinkDialogState>({
    isOpen: false,
    isEditing: false,
  });

  const openInsert = useCallback((selectedText?: string) => {
    setState({
      isOpen: true,
      selectedText,
      initialData: undefined,
      isEditing: false,
    });
  }, []);

  const openEdit = useCallback((data: HyperlinkData) => {
    setState({
      isOpen: true,
      initialData: data,
      selectedText: data.displayText,
      isEditing: true,
    });
  }, []);

  const close = useCallback(() => {
    setState((prev) => ({
      ...prev,
      isOpen: false,
    }));
  }, []);

  const toggle = useCallback(() => {
    setState((prev) => ({
      ...prev,
      isOpen: !prev.isOpen,
    }));
  }, []);

  return { state, openInsert, openEdit, close, toggle };
}
