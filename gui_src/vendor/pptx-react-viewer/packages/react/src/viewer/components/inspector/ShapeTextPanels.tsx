import type { PptxElement, ShapeStyle, TextStyle } from 'pptx-viewer-core';
import { hasShapeProperties, hasTextProperties } from 'pptx-viewer-core';
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
	LuAlignCenter,
	LuAlignJustify,
	LuAlignLeft,
	LuAlignRight,
	LuAlignVerticalJustifyCenter,
	LuAlignVerticalJustifyEnd,
	LuAlignVerticalJustifyStart,
} from 'react-icons/lu';

import { SHAPE_PRESETS } from '../../constants';
import { cn, normalizeHexColor } from '../../utils';
import { DebouncedColorInput } from './DebouncedColorInput';
import { CARD, HEADING, INPUT } from './inspector-pane-constants';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ShapeTextPanelsProps {
	selectedElement: PptxElement;
	canEdit: boolean;
	onUpdateElement: (updates: Partial<PptxElement>) => void;
	onUpdateElementStyle: (patch: Partial<ShapeStyle>) => void;
	onUpdateTextStyle: (patch: Partial<TextStyle>) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ShapeTextPanels({
	selectedElement,
	canEdit,
	onUpdateElement,
	onUpdateElementStyle,
	onUpdateTextStyle,
}: ShapeTextPanelsProps): React.ReactElement {
	const { t } = useTranslation();

	return (
		<>
			{/* Shape Type */}
			{hasShapeProperties(selectedElement) && (
				<div className={CARD}>
					<div className={HEADING}>{t('pptx.shape.type', 'Shape Type')}</div>
					<select
						value={selectedElement.shapeType || 'rect'}
						disabled={!canEdit}
						className={cn(INPUT, 'w-full')}
						onChange={(e) =>
							onUpdateElement({
								shapeType: e.target.value,
							} as Partial<PptxElement>)
						}
					>
						{SHAPE_PRESETS.filter((p) => p.type !== 'connector').map((p) => (
							<option key={p.type} value={p.type}>
								{t(p.i18nKey)}
							</option>
						))}
					</select>
				</div>
			)}

			{/* Fill & Stroke */}
			{hasShapeProperties(selectedElement) && (
				<div className={CARD}>
					<div className={HEADING}>{t('pptx.shape.fillStroke', 'Fill & Stroke')}</div>
					<div className='grid grid-cols-2 gap-1.5 text-[11px]'>
						<label className='flex flex-col gap-1'>
							<span className='text-muted-foreground'>Fill</span>
							<DebouncedColorInput
								disabled={!canEdit}
								value={normalizeHexColor(selectedElement.shapeStyle?.fillColor, '#3b82f6')}
								className='w-full h-7 rounded border border-border bg-transparent cursor-pointer'
								onCommit={(hex) => onUpdateElementStyle({ fillColor: hex, fillMode: 'solid' })}
							/>
						</label>
						<label className='flex flex-col gap-1'>
							<span className='text-muted-foreground'>Stroke</span>
							<DebouncedColorInput
								disabled={!canEdit}
								value={normalizeHexColor(selectedElement.shapeStyle?.strokeColor, '#1f2937')}
								className='w-full h-7 rounded border border-border bg-transparent cursor-pointer'
								onCommit={(hex) => onUpdateElementStyle({ strokeColor: hex })}
							/>
						</label>
						<label className='flex items-center gap-1 col-span-2'>
							<span className='w-16 text-muted-foreground'>
								{t('pptx.shapeText.strokeWidthAbbrev')}
							</span>
							<input
								type='number'
								disabled={!canEdit}
								className={INPUT}
								min={0}
								max={20}
								value={selectedElement.shapeStyle?.strokeWidth ?? 1}
								onChange={(e) => onUpdateElementStyle({ strokeWidth: Number(e.target.value) })}
							/>
						</label>
					</div>
				</div>
			)}

			{/* Text Color & Font Size */}
			{hasTextProperties(selectedElement) && (
				<div className={CARD}>
					<div className={HEADING}>{t('pptx.text.title', 'Text')}</div>
					<div className='grid grid-cols-2 gap-1.5 text-[11px]'>
						<label className='flex flex-col gap-1'>
							<span className='text-muted-foreground'>Size</span>
							<input
								type='number'
								disabled={!canEdit}
								className={INPUT}
								min={6}
								max={200}
								value={selectedElement.textStyle?.fontSize ?? 18}
								onChange={(e) => onUpdateTextStyle({ fontSize: Number(e.target.value) })}
							/>
						</label>
						<label className='flex flex-col gap-1'>
							<span className='text-muted-foreground'>Color</span>
							<DebouncedColorInput
								disabled={!canEdit}
								value={normalizeHexColor(selectedElement.textStyle?.color, '#000000')}
								className='w-full h-7 rounded border border-border bg-transparent cursor-pointer'
								onCommit={(hex) => onUpdateTextStyle({ color: hex })}
							/>
						</label>
						{/* Alignment. Horizontal alignment alone cannot centre a caption
						    inside a box — a single line still sits at the top — so the
						    vertical anchor (OOXML `a:bodyPr/@anchor`) is offered right
						    beside it, which is also where PowerPoint keeps the pair. */}
						<div className='col-span-2 flex flex-col gap-1'>
							<span className='text-muted-foreground'>
								{t('pptx.text.alignHorizontal')}
							</span>
							<div className='flex gap-1'>
								{H_ALIGN_OPTIONS.map((option) => (
									<TextAlignToggle
										key={option.value}
										icon={option.icon}
										label={t(option.labelKey)}
										active={(selectedElement.textStyle?.align ?? 'left') === option.value}
										disabled={!canEdit}
										onClick={() => onUpdateTextStyle({ align: option.value })}
									/>
								))}
							</div>
						</div>
						<div className='col-span-2 flex flex-col gap-1'>
							<span className='text-muted-foreground'>{t('pptx.text.alignVertical')}</span>
							<div className='flex gap-1'>
								{V_ALIGN_OPTIONS.map((option) => (
									<TextAlignToggle
										key={option.value}
										icon={option.icon}
										label={t(option.labelKey)}
										active={(selectedElement.textStyle?.vAlign ?? 'top') === option.value}
										disabled={!canEdit}
										onClick={() => onUpdateTextStyle({ vAlign: option.value })}
									/>
								))}
							</div>
						</div>
						<div className='flex gap-1 col-span-2'>
							<TextFormatToggle
								label='B'
								active={Boolean(selectedElement.textStyle?.bold)}
								disabled={!canEdit}
								onClick={() => onUpdateTextStyle({ bold: !selectedElement.textStyle?.bold })}
							/>
							<TextFormatToggle
								label='I'
								active={Boolean(selectedElement.textStyle?.italic)}
								disabled={!canEdit}
								italic
								onClick={() =>
									onUpdateTextStyle({
										italic: !selectedElement.textStyle?.italic,
									})
								}
							/>
							<TextFormatToggle
								label='U'
								active={Boolean(selectedElement.textStyle?.underline)}
								disabled={!canEdit}
								underline
								onClick={() =>
									onUpdateTextStyle({
										underline: !selectedElement.textStyle?.underline,
									})
								}
							/>
						</div>
					</div>
				</div>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// Alignment option tables
// ---------------------------------------------------------------------------

const ALIGN_ICON = 'w-3.5 h-3.5';

/** Paragraph alignment within the text body. */
const H_ALIGN_OPTIONS: Array<{
	value: NonNullable<TextStyle['align']>;
	icon: React.ReactNode;
	labelKey: string;
}> = [
	{ value: 'left', icon: <LuAlignLeft className={ALIGN_ICON} />, labelKey: 'pptx.ribbon.alignLeft' },
	{
		value: 'center',
		icon: <LuAlignCenter className={ALIGN_ICON} />,
		labelKey: 'pptx.ribbon.alignCenter',
	},
	{
		value: 'right',
		icon: <LuAlignRight className={ALIGN_ICON} />,
		labelKey: 'pptx.ribbon.alignRight',
	},
	{
		value: 'justify',
		icon: <LuAlignJustify className={ALIGN_ICON} />,
		labelKey: 'pptx.ribbon.justify',
	},
];

/** Vertical anchor of the whole text body inside the shape. */
const V_ALIGN_OPTIONS: Array<{
	value: NonNullable<TextStyle['vAlign']>;
	icon: React.ReactNode;
	labelKey: string;
}> = [
	{
		value: 'top',
		icon: <LuAlignVerticalJustifyStart className={ALIGN_ICON} />,
		labelKey: 'pptx.ribbon.alignTextTop',
	},
	{
		value: 'middle',
		icon: <LuAlignVerticalJustifyCenter className={ALIGN_ICON} />,
		labelKey: 'pptx.ribbon.alignTextMiddle',
	},
	{
		value: 'bottom',
		icon: <LuAlignVerticalJustifyEnd className={ALIGN_ICON} />,
		labelKey: 'pptx.ribbon.alignTextBottom',
	},
];

// ---------------------------------------------------------------------------
// Private sub-components
// ---------------------------------------------------------------------------

interface TextAlignToggleProps {
	icon: React.ReactNode;
	label: string;
	active: boolean;
	disabled: boolean;
	onClick: () => void;
}

function TextAlignToggle({
	icon,
	label,
	active,
	disabled,
	onClick,
}: TextAlignToggleProps): React.ReactElement {
	return (
		<button
			type='button'
			disabled={disabled}
			title={label}
			aria-label={label}
			aria-pressed={active}
			className={cn(
				'flex-1 flex items-center justify-center py-1 rounded transition-colors',
				active ? 'bg-primary text-white' : 'bg-muted hover:bg-accent',
			)}
			onClick={onClick}
		>
			{icon}
		</button>
	);
}

interface TextFormatToggleProps {
	label: string;
	active: boolean;
	disabled: boolean;
	italic?: boolean;
	underline?: boolean;
	onClick: () => void;
}

function TextFormatToggle({
	label,
	active,
	disabled,
	italic,
	underline,
	onClick,
}: TextFormatToggleProps): React.ReactElement {
	return (
		<button
			type='button'
			disabled={disabled}
			className={cn(
				'px-2 py-1 rounded text-[11px] transition-colors',
				italic && 'italic',
				underline && 'underline',
				active ? 'bg-primary text-white' : 'bg-muted hover:bg-accent',
			)}
			onClick={onClick}
		>
			{label}
		</button>
	);
}
