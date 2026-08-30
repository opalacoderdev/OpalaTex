import type React from 'react';
import { useTranslation } from 'react-i18next';
import { LuCopyPlus, LuFolderPlus, LuTrash2 } from 'react-icons/lu';

import type { SlideContextMenuState } from './types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SlideContextMenuProps {
	state: SlideContextMenuState;
	onAddSection?: (name: string, afterSlideIndex: number) => void;
	onDuplicateSlide?: (slideIndex: number) => void;
	onDeleteSlide?: (slideIndex: number) => void;
	onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SlideContextMenu({
	state,
	onAddSection,
	onDuplicateSlide,
	onDeleteSlide,
	onClose,
}: SlideContextMenuProps): React.ReactElement {
	const { t } = useTranslation();

	return (
		<div
			className='fixed z-50 min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-xl'
			style={{ left: state.x, top: state.y }}
			onClick={(e: React.MouseEvent) => e.stopPropagation()}
		>
			{onDuplicateSlide && (
				<button
					type='button'
					className='flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-muted text-left'
					onClick={() => {
						onDuplicateSlide(state.slideIndex);
						onClose();
					}}
				>
					<LuCopyPlus className='h-3.5 w-3.5 text-muted-foreground' />
					{t('pptx.ribbon.duplicateSlide')}
				</button>
			)}
			{onDeleteSlide && (
				<button
					type='button'
					className='flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-muted text-left'
					onClick={() => {
						onDeleteSlide(state.slideIndex);
						onClose();
					}}
				>
					<LuTrash2 className='h-3.5 w-3.5 text-muted-foreground' />
					{t('pptx.slidesPanel.deleteSlide')}
				</button>
			)}
			<div className='my-1 border-t border-border' />
			<button
				type='button'
				className='flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-muted text-left'
				onClick={() => {
					onAddSection?.(t('pptx.sections.defaultName'), state.slideIndex);
					onClose();
				}}
			>
				<LuFolderPlus className='h-3.5 w-3.5 text-muted-foreground' />
				{t('pptx.sections.addBefore')}
			</button>
		</div>
	);
}
