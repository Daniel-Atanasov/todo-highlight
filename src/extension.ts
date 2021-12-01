import * as vscode from 'vscode';
import {
	Range,
	TextEditor,
	ExtensionContext,
	DecorationOptions,
	TextEditorDecorationType,
	DecorationRenderOptions,
	TextDocument,
	MarkdownString
} from 'vscode';

interface Dictionary<T> {
	[Key: string]: T;
}

interface AnnotationRenderOptions extends DecorationRenderOptions {
	name: string;
	pattern: string;
	isMarkdown?: boolean;
}

interface Language {
	languageIds: Array<string>;
	lineComments: Array<string>;
	blockComments: Array<string>;
	skippedBlocks: Array<string>;
	combinedCommentRegex?: RegExp;
	combinedAnnotationRegex?: RegExp;
}

class DecorationType {
	constructor(
		public name: string,
		public pattern: string,
		public type: TextEditorDecorationType,
		public isMarkdown?: boolean
	) {
		this.options = [];
	}

	options: Array<DecorationOptions> = [];
}

class GlobalState {
	private static instance: GlobalState;

	private constructor(
		public languages: Array<Language>,
		public annotations: Dictionary<DecorationType>
	) { }

	private static getAnnotationRegex(info: Language): RegExp {
		const globalState = GlobalState.getInstance();
		const annotations = globalState.annotations;

		// TODO@Daniel:
		//   Add language-specific annotations
		const patterns = Object.values(annotations).map(t => `(?<${t.name}>${t.pattern})`);
		const pattern = patterns.join("|");
		return new RegExp(pattern, "g");
	}

	private static getCommentRegex(info: Language): RegExp {
		const lineComments = info.lineComments.join("|");
		const blockComments = info.blockComments.join("|");
		const skippedBlocks = info.skippedBlocks.join("|");
		const pattern = [
			`(?<body>${lineComments}|${blockComments})`,
			`(?:${skippedBlocks})`
		].join("|");
		return new RegExp(pattern, "g");
	}

	public static getInstance(): GlobalState {
		return GlobalState.instance;
	}

	public static reload() {
		const configuration = vscode.workspace.getConfiguration("todo");
		const annotationOptions = configuration.get<Array<AnnotationRenderOptions>>("annotations");
		const languages = configuration.get<Array<Language>>("languages");

		if (annotationOptions === undefined || languages === undefined) {
			return;
		}

		if (GlobalState.instance !== undefined) {
			for (const annotation of Object.values(GlobalState.instance.annotations)) {
				annotation.type.dispose();
			}
		}

		let annotations: Dictionary<DecorationType> = {};
		for (const options of annotationOptions) {
			const decorationType = vscode.window.createTextEditorDecorationType(options);
			annotations[options.name] = new DecorationType(
				options.name,
				options.pattern,
				decorationType,
				options.isMarkdown
			);
		}

		GlobalState.instance = new GlobalState(languages, annotations);

		for (const language of languages) {
			language.combinedCommentRegex = GlobalState.getCommentRegex(language);
			language.combinedAnnotationRegex = GlobalState.getAnnotationRegex(language);
		}

		decorateVisibleEditors();
	}
}

function findAnnotations(document: TextDocument, info: Language, text: string, offset: number) {
	const globalState = GlobalState.getInstance();
	const annotations = globalState.annotations;

	const regex = info.combinedAnnotationRegex;
	if (regex === undefined) {
		return;
	}

	let match;
	while ((match = regex.exec(text)) !== null) {
		const groups = match.groups;
		if (groups === undefined) {
			continue;
		}

		for (const [key, annotation] of Object.entries(annotations)) {
			const value = groups[key];
			if (value === undefined) {
				continue;
			}

			// NOTE@Daniel:
			//   Empty matches do not increment lastIndex for some dumb reason
			if (value === '') {
				regex.lastIndex++;
				continue;
			}

			const start = offset + match.index;
			const stop = offset + match.index + match[0].length;

			const decoration: DecorationOptions = {
				range: new Range(
					document.positionAt(start),
					document.positionAt(stop)
				)
			};

			if (annotation.isMarkdown) {
				decoration.hoverMessage = new MarkdownString(value);
				decoration.hoverMessage.isTrusted = true;
				decoration.hoverMessage.supportThemeIcons = true;
				decoration.hoverMessage.supportHtml = true;
			}

			annotation.options.push(decoration);
		}
	}
}

function findComments(document: TextDocument, info: Language) {
	const text = document.getText();

	const regex = info.combinedCommentRegex;
	if (regex === undefined) {
		return;
	}

	let match;
	while ((match = regex.exec(text)) !== null) {
		const body = match.groups?.body;
		if (body === undefined) {
			continue;
		}

		// NOTE@Daniel:
		//   Empty matches do not increment lastIndex for some dumb reason
		if (body === '') {
			regex.lastIndex++;
			continue;
		}

		findAnnotations(document, info, body, match.index);
	}
}

function decorate(editor: TextEditor) {
	const document = editor.document;
	const globalState = GlobalState.getInstance();

	for (const value of Object.values(globalState.annotations)) {
		value.options = [];
	}

	for (const info of globalState.languages) {
		if (!info.languageIds.includes(document.languageId)) {
			continue;
		}

		findComments(document, info);
	}

	for (const result of Object.values(globalState.annotations)) {
		editor.setDecorations(result.type, result.options);
	}
}

function decorateVisibleEditors() {
	for (const editor of vscode.window.visibleTextEditors) {
		if (editor !== undefined && editor !== null) {
			decorate(editor);
		}
	}
}

export function activate(context: ExtensionContext) {
	GlobalState.reload();

	const onTextChangedCommand = vscode.workspace.onDidChangeTextDocument(decorateVisibleEditors);
	const onTextEditorChanged = vscode.window.onDidChangeActiveTextEditor(decorateVisibleEditors);
	const onConfigurationChanged = vscode.workspace.onDidChangeConfiguration(GlobalState.reload);

	context.subscriptions.push(onTextChangedCommand);
	context.subscriptions.push(onTextEditorChanged);
	context.subscriptions.push(onConfigurationChanged);
}
