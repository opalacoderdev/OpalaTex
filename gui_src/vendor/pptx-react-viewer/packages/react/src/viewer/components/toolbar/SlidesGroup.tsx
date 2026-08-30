import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
	LuChevronDown,
	LuCopyPlus,
	LuFolderPlus,
	LuLayoutGrid,
	LuPlus,
	LuRotateCcw,
	LuTrash2,
} from 'react-icons/lu';

import { cn } from '../../utils';
import { RibbonGroup } from './PowerPointRibbonControls';
import { ic, pill } from './toolbar-constants';

export interface SlidesGroupProps {
	canEdit: boolean;
	layoutOptions: Array<{ path: string; name: string }>;
	onInsertSlideFromLayout: (path: string, name?: string) => void;
	onApplyLayout?: (path: string) => void;
	onResetSlide?: () => void;
	onDuplicateActiveSlide?: () => void;
	onDeleteActiveSlide?: () => void;
	canDeleteActiveSlide?: boolean;
	onAddSection?: () => void;
}

export function SlidesGroup(p: SlidesGroupProps): React.ReactElement {
	const { t } = useTranslation();
	const [newSlideMenuOpen, setNewSlideMenuOpen] = useState(false);
	const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
	const newSlideMenuRef = useRef<HTMLDivElement>(null);
	const layoutMenuRef = useRef<HTMLDivElement>(null);

	const handleNewSlide = useCallback(() => {
		if (p.layoutOptions.length > 0) {
			const first = p.layoutOptions[0];
			p.onInsertSlideFromLayout(first.path, first.name);
		}
	}, [p]);

	useEffect(() => {
		if (!newSlideMenuOpen) {
			return;
		}
		const handler = (e: MouseEvent) => {
			if (newSlideMenuRef.current && !newSlideMenuRef.current.contains(e.target as Node)) {
				setNewSlideMenuOpen(false);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [newSlideMenuOpen]);

	useEffect(() => {
		if (!layoutMenuOpen) {
			return;
		}
		const handler = (e: MouseEvent) => {
			if (layoutMenuRef.current && !layoutMenuRef.current.contains(e.target as Node)) {
				setLayoutMenuOpen(false);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [layoutMenuOpen]);

	return (
		<RibbonGroup label={t('pptx.ribbon.group.slides')}>
			{/* New Slide split button */}
			<div className='relative inline-flex items-center' ref={newSlideMenuRef}>
				<button
					type='button'
					onClick={handleNewSlide}
					disabled={!p.canEdit || p.layoutOptions.length === 0}
					className={cn(
						pill,
						'whitespace-nowrap',
						p.layoutOptions.length > 0 ? 'rounded-r-none' : '',
					)}
					title={t('pptx.home.newSlide')}
				>
					<LuPlus className={ic} />
					{t('pptx.home.newSlide')}
				</button>
				{p.layoutOptions.length > 0 && (
					<button
						type='button'
						disabled={!p.canEdit}
						className='inline-flex items-center justify-center self-stretch px-1 rounded-r bg-muted hover:bg-accent text-xs transition-colors border-l border-border/40 active:scale-95 active:opacity-80'
						title={t('pptx.home.chooseLayout')}
						onClick={() => setNewSlideMenuOpen((v) => !v)}
					>
						<LuChevronDown className='w-3 h-3' />
					</button>
				)}
				{newSlideMenuOpen && (
					<div className='absolute left-0 top-full z-50 flex flex-col w-48 pt-1'>
						<div className='rounded-lg border border-border bg-popover backdrop-blur-lg shadow-2xl py-1 max-h-60 overflow-y-auto'>
							{p.layoutOptions.map((lo) => (
								<button
									key={lo.path}
									type='button'
									className='flex items-center gap-2 w-full px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors'
									onClick={() => {
										p.onInsertSlideFromLayout(lo.path, lo.name);
										setNewSlideMenuOpen(false);
									}}
								>
									{lo.name}
								</button>
							))}
						</div>
					</div>
				)}
			</div>

			{/* Layout button */}
			<div className='relative inline-flex items-center' ref={layoutMenuRef}>
				<button
					type='button'
					disabled={!p.canEdit || p.layoutOptions.length === 0}
					className={pill}
					title={t('pptx.master.layout')}
					onClick={() => setLayoutMenuOpen((v) => !v)}
				>
					<LuLayoutGrid className={ic} />
					{t('pptx.master.layout')}
				</button>
				{layoutMenuOpen && (
					<div className='absolute left-0 top-full z-50 flex flex-col w-48 pt-1'>
						<div className='rounded-lg border border-border bg-popover backdrop-blur-lg shadow-2xl py-1 max-h-60 overflow-y-auto'>
							{p.layoutOptions.map((lo) => (
								<button
									key={lo.path}
									type='button'
									className='flex items-center gap-2 w-full px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors'
									onClick={() => {
										p.onApplyLayout?.(lo.path);
										setLayoutMenuOpen(false);
									}}
								>
									{lo.name}
								</button>
							))}
						</div>
					</div>
				)}
			</div>

			{/* Duplicate active slide */}
			<button
				type='button'
				disabled={!p.canEdit || !p.onDuplicateActiveSlide}
				className={pill}
				title={t('pptx.ribbon.duplicateSlide')}
				onClick={p.onDuplicateActiveSlide}
			>
				<LuCopyPlus className={ic} />
				{t('pptx.ribbon.duplicateSlide')}
			</button>

			{/* Reset button */}
			<button
				type='button'
				disabled={!p.canEdit}
				className={pill}
				title={t('pptx.sections.resetSlideTitle')}
				onClick={p.onResetSlide}
			>
				<LuRotateCcw className={ic} />
				{t('pptx.animations.reset')}
			</button>

			{/* Delete the active slide, not the selected element inside a slide. */}
			<button
				type='button'
				disabled={!p.canEdit || !p.canDeleteActiveSlide || !p.onDeleteActiveSlide}
				className='inline-flex items-center gap-1.5 px-2.5 py-1.5 max-md:min-h-[44px] rounded bg-red-700/80 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-xs transition-colors active:scale-95 active:opacity-80'
				title={t('pptx.slidesPanel.deleteSlide')}
				onClick={p.onDeleteActiveSlide}
			>
				<LuTrash2 className={ic} />
				{t('pptx.arrange.delete')}
			</button>

			{/* Section button */}
			<button
				type='button'
				disabled={!p.canEdit}
				className={pill}
				title={t('pptx.sections.addSection')}
				onClick={p.onAddSection}
			>
				<LuFolderPlus className={ic} />
				{t('pptx.sections.sectionButtonLabel')}
			</button>
		</RibbonGroup>
	);
}
