import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { writeFile } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import { configSchematics } from "./config";

export async function toolsProvider(ctl:ToolsProviderController):Promise<Tool[]> {
	const tools:Tool[] = [];

	const htmlToPlainText = (html:string):string => html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|h[1-6]|tr|td|th|section|article|header|footer|nav|ul|ol|table|blockquote|dl|dt|dd|figure|figcaption|main|aside|hr)>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/[ \t\f\v\u00a0]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/ *\n */g, '\n')
		.trim();

	// Build a markdown link with text/URL escaped so brackets, parens, and newlines can't break it. Prefix "!" for an image.
	const toMarkdownLink = (text:string, url:string):string => {
		const safeText = text
			.replace(/\\/g, '\\\\') // escape backslashes first
			.replace(/[\[\]]/g, '\\$&') // escape brackets
			.replace(/\s+/g, ' ')
			.trim();
		const safeUrl = url.trim().replace(/[()\s]/g, encodeURIComponent); // encode parens/spaces that would close the url
		return `[${safeText}](${safeUrl})`;
	};

	const fetchHTML = async (url:string, signal:AbortSignal, warn:(msg:string) => void) => {
		// Perform the fetch request with abort signal
		const headers = spoofHeaders(url);
		const response = await fetch(url, {
			method: "GET",
			signal,
			headers,
		});
		if (!response.ok) {
			warn(`Failed to fetch website: ${response.statusText}`);
			throw new Error(`Failed to fetch website: ${response.statusText}`);
		}
		const html = await response.text();
		const headStart = html.indexOf("<head>");
		const headEnd = html.indexOf("</head>") + 7;
		const head = html.substring(headStart, headEnd);
		const bodyStart = html.match(/<body[^>]*>/)?.index || 0;
		const bodyEnd = html.lastIndexOf("</body>") || html.length - 1;
		const body = html.substring(bodyStart, bodyEnd);
		return { html, head, body };
	}

	const extractLinks = (body:string, url:string, maxLinks:number, searchTerms?:string[]) =>
		[...body.matchAll(/<a\s+[^>]*?href="([^"]+)"[^>]*>((?:\n|.)*?)<\/a>/g)]
			.map((match, index) => ({
				index,
				label: htmlToPlainText(match[2] || "").replace(/\n+/g, ' ').trim() || "",
				link: match[1]?.startsWith("/")
					? new URL(match[1], url).href
					: match[1],
			}))
			.filter(({ link }) => link?.startsWith("http"))
			.map((x, index, { length }) => {
				// Prioritize links fitting the search terms
				// Followed by short navigation links and content links with long labels
				// Fewer digits = more likely a navigation link than a content link
				const ratio = 1 / Math.min(1, /\d/g.exec(x.link)?.length || 1);
				const score
					= ratio * (100 - (x.label.length + x.link.length + (20 * index / length)))
					+ (1 - ratio) * x.label.split(/\s+/).length;
				return {
					...x,
					score: searchTerms?.length
						&& searchTerms.reduce((acc, term) => acc + (x.label.toLowerCase().includes(term.toLowerCase()) ? 1000 : 0), score)
						|| score,
				};
			})
			.sort((a, b) => b.score - a.score) // Sort by score in descending order
			.filter((x, i, arr) =>
				// Filter out duplicates based on link, keeping the first occurrence
				!arr.find((y, j) => j < i && y.link === x.link)
			)
			.slice(0, maxLinks) // Limit number of links
			// .sort((a, b) => a.index - b.index) // Sort by original order in the body
			.map(({ label, link }) => toMarkdownLink(label || link, link)); // Fall back to the URL when there's no link text

	const extractImages = (body:string, url:string, maxImages:number, searchTerms?:string[]) =>
		[...body.matchAll(/<img\b([^>]*?)\/?>/gi)]
			.filter(x => x[1])
			.map(([, attributes], index) => {
				const alt = attributes.match(/(?:^|\s)alt=["']([^"']+)["']/i)?.[1] || "";
				const src = attributes.match(/(?:^|\s)src=["']([^"']+)["']/i)?.[1]
					|| attributes.match(/(?:^|\s)data-src=["']([^"']+)["']/i)?.[1]; // Fall back to data-src for lazy-loaded images
				return {
					index,
					alt,
					src: src?.startsWith("/")
						? new URL(src, url).href
						: src!,
					score: searchTerms?.length
						&& searchTerms.reduce((acc, term) => acc + (alt.toLowerCase().includes(term.toLowerCase()) ? 1000 : 0), alt.length)
						|| alt.length,
				};
			})
			.filter(({ src }) => {
				// Image URLs must be http(s) but may lack a file extension (e.g. Cloudinary, Unsplash, imgix CDN URLs)
				if (!src || !src.startsWith('http')) return false;
				const extension = /\.([a-z0-9]+)$/i.exec(src.split('?')[0])?.[1]?.toLowerCase();
				return !extension || !nonImageExtensions.includes(extension);
			})
			.sort((a, b) => b.score - a.score) // Sort by score in descending order
			.slice(0, maxImages) // Limit number of images
			.sort((a, b) => a.index - b.index); // Sort by original order in the body

	// Download images to the working directory and return them as escaped markdown image references (alt preserved).
	const downloadImages = async (
		images:{ alt:string, src:string }[],
		status:(msg:string) => void,
		warn:(msg:string) => void,
		signal:AbortSignal,
	):Promise<string[]> => {
		status("Downloading images...");
		const workingDirectory = ctl.getWorkingDirectory();
		const timestamp = Date.now();
		const downloadPromises = images.map(async ({ alt, src }, i) => {
			if(!/^https?:\/\//i.test(src))
				return "!" + toMarkdownLink(alt, src); // Local path or already-downloaded file — pass through

			const index = i + 1;
			try {
				const headers = spoofHeaders(src);
				const imageResponse = await fetch(src, {
					method: "GET",
					signal,
					headers,
				});
				if (!imageResponse.ok) {
					warn(`Failed to fetch image ${index}: ${imageResponse.statusText}`);
					return null; // Skip this image if download fails
				}
				const bytes = await imageResponse.bytes();
				if (bytes.length === 0) {
					warn(`Image ${index} is empty: ${src}`);
					return null; // Skip empty images
				}
				// save the image to a file in the working directory
				const mimeType = (imageResponse.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
				const fileExtension = mimeToExtension[mimeType]
					|| /\.([a-z0-9]+)$/i.exec(src.split('?')[0])?.[1]?.toLowerCase() // Extract extension from URL if content type is not available
					|| 'jpg'; // Default to jpg if no content type
				const fileName = `${timestamp}-${index}.${fileExtension}`;
				const filePath = join(workingDirectory, fileName);
				const localPath = filePath.replace(/\\/g, '/').replace(/^C:/, '') // Normalize path for web compatibility
				await writeFile(filePath, bytes, 'binary');
				return "!" + toMarkdownLink(alt, localPath);
			} catch (error:unknown) {
				if (error instanceof DOMException && error.name === "AbortError")
					return null; // Skip if download was aborted
				warn(`Error fetching image ${index}: ${error instanceof Error ? error.message : String(error)}`);
				return null; // Skip this image on error
			}
		});
		return (await Promise.all(downloadPromises)).filter((x):x is string => x !== null);
	};

	// Vision analysis over working-directory images using the current model; prompt and target word count are supplied by the caller.
	const analyzeImages = async (
		paths:string[],
		prompt:string,
		targetWords:number,
		status:(msg:string) => void,
		warn:(msg:string) => void,
	) => {
		try {
			const model = await ctl.client.llm.model();
			if (!model.vision)
				return "Error: The current model does not support vision. Load a vision-capable model to analyze images.";
			const workingDirectory = ctl.getWorkingDirectory();
			let content = prompt.trim();
			if (!content.endsWith('.'))
				content += '.';
			if(!/\d+\s*(word|token|sentence)s?/i.test(content) && targetWords > 0)
				content += ` Keep the response to roughly ${targetWords} words.`;
			const maxTokens = Math.round(targetWords / 0.75 * 2); // words to tokens (~1.33/word), doubled so the cap won't truncate the target
			// Some reasoning models leak their hidden thinking into the output; keep only the final answer.
			const stripReasoning = (text:string):string | null => {
				text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
				const openIdx = text.indexOf('<|channel>');
				if (openIdx === -1) return text || null;
				const closeIdx = text.indexOf('<channel|>');
				const after = closeIdx !== -1 ? text.slice(closeIdx + '<channel|>'.length).trim() : '';
				if (after) return after;
				// Nothing after the closing tag (or none present) — fall back to the content inside the block
				const insideStart = openIdx + '<|channel>'.length;
				const insideEnd = closeIdx !== -1 ? closeIdx : text.length;
				return text.slice(insideStart, insideEnd).replace(/^\w+\n/, '').trim() || null;
			};
			status(`Analyzing ${paths.length} image${paths.length > 1 ? "s" : ""}...`);
			// One request per image; LM Studio queues past its parallel slots, and Promise.all preserves order.
			return await Promise.all(paths.map(async (imagePath, i):Promise<{ path:string; analysis:string | null }> => {
				const filename = imagePath.replace(/^!\[[^\]]*\]\(/, '').replace(/\)$/, '').split('/').pop()!;
				const absolutePath = join(workingDirectory, filename);
				try {
					const fileHandle = await ctl.client.files.prepareImage(absolutePath);
					const result = await model.respond([{
						role: "user",
						content,
						images: [fileHandle],
					}], { maxTokens });
					return { path: imagePath, analysis: stripReasoning(result.content) };
				} catch (error:unknown) {
					if (error instanceof Error)
						warn(`Failed to analyze image ${i + 1}: ${error.message}`);
					return { path: imagePath, analysis: null };
				}
			}));
		} catch (error:unknown) {
			if (error instanceof DOMException && error.name === "AbortError")
				return "Analysis aborted by user.";
			if (error instanceof Error)
				return `Error: ${error.message}`;
			return "Unknown error occurred during analysis.";
		}
	};

	const viewImagesTool = tool({
		name: "View Images",
		description: "View images from online URLs and/or local paths. Returns one { image, analysis } per image; write each returned `image` markdown into your reply, not inside a code block, to display it. Optionally describe each image with the current vision model (see wordsPerImage and focus).",
		parameters: {
			imageURLs: z.array(z.string()).min(1).describe("Online image URLs and/or local image paths (or ![alt](path) markdown) to view."),
			wordsPerImage: z.number().int().min(0).max(1000).optional().describe("How long each image's description should be, in words. Set this whenever you analyze so descriptions stay concise; about 100 divided by the number of images is a good target (e.g. ~10 words each for 10 images). Analysis runs when this or focus is set."),
			focus: z.string().optional().describe("What to focus on when analyzing. Providing it enables analysis even when wordsPerImage is omitted. Defaults to a detailed general description."),
		},
		implementation: async ({ imageURLs, wordsPerImage, focus }, { status, warn, signal }) => {
			try {
				const items = imageURLs.map((ref, i) => ({
					alt: ref.match(/^!\[([^\]]*)\]/)?.[1] || `Image ${i + 1}`,
					src: ref.replace(/^!\[[^\]]*\]\(/, '').replace(/\)$/, '').trim(),
				}));

				const markdowns = await downloadImages(items, status, warn, signal);
				if (markdowns.length === 0) {
					warn('Error fetching images');
					return items.map(({ alt }) => ({ image: "!" + toMarkdownLink(alt, ""), analysis: null }));
				}

				// A task implies the caller wants analysis; default its length to the recommended ~100/image budget (min 5).
				const targetWords = wordsPerImage && wordsPerImage > 0
					? wordsPerImage
					: focus
						? Math.round(Math.max(100 / imageURLs.length, 5))
						: 0;
				let analyses:(string | null)[] = markdowns.map(() => null);
				if (targetWords > 0) {
					const prompt = focus ?? "Describe this image. Start with its type (photo, illustration, screenshot, texture, icon, diagram, etc.), describe the style, setting, composition, function, viewing angle, and surroundings, then focus on the main subject in great detail followed by any other notable details. No introductory phrases. If in doubt about the type, name all that apply with the most likely option first.";
					const result = await analyzeImages(markdowns, prompt, targetWords, status, warn);
					if (Array.isArray(result))
						analyses = result.map(r => r.analysis);
					else
						warn(result); // e.g. no vision model loaded — keep the images, skip analysis
				}

				status(`Viewed ${markdowns.length} image${markdowns.length > 1 ? "s" : ""}.`);
				return markdowns.map((image, i) => ({ image, analysis: analyses[i] }));
			} catch (error:unknown) {
				if (error instanceof DOMException && error.name === "AbortError")
					return "Image viewing aborted by user.";
				if (error instanceof Error) {
					warn(`Error during image viewing: ${error.message}`);
					return `Error: ${error.message}`;
				}
				warn(`Error during image viewing: ${String(error)}`);
				return `Error: ${String(error)}`;
			}
		}
	});

	const visitWebsiteTool = tool({
		name: "Visit Website",
		description: "Visit a website and return its title, headings, links, images, and text content. Links and images are returned as ready-to-use markdown ([text](url) and ![alt](path)); images are automatically downloaded, so write each image markdown directly into your reply (not in a code block) to display them.",
		parameters: {
			url: z.string().url().describe("The URL of the website to visit"),
			findInPage: z.array(z.string()).optional().describe("Highly recommended! Optional search terms to prioritize which links, images, and content to return."),
			maxLinks: z.number().int().min(0).max(200).optional().describe("Maximum number of links to extract from the page."),
			maxImages: z.number().int().min(0).max(200).optional().describe("Maximum number of images to extract from the page."),
			contentLimit: z.number().int().min(0).max(10_000).optional().describe("Maximum text content length to extract from the page."),
		},
		implementation: async ({ url, maxLinks, maxImages, contentLimit, findInPage: searchTerms }, context) => {
			const { status, warn, signal } = context;
			status("Visiting website...");

			try {
				maxLinks = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("maxLinks"), -1)
					?? maxLinks
					?? 40;
				maxImages = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("maxImages"), -1)
					?? maxImages
					?? 10;
				contentLimit = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("contentLimit"), -1)
					?? contentLimit
					?? 2000;

				const { head, body } = await fetchHTML(url, signal, warn);
				status("Website visited successfully.");
				
				const title = head.match(/<title>([^<]*)<\/title>/)?.[1] || ""
				const h1 = body.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1] || "";
				const h2 = body.match(/<h2[^>]*>([^<]*)<\/h2>/)?.[1] || "";
				const h3 = body.match(/<h3[^>]*>([^<]*)<\/h3>/)?.[1] || "";
				const links = maxLinks && extractLinks(body, url, maxLinks, searchTerms);
				const imagesToFetch = maxImages ? extractImages(body, url, maxImages, searchTerms) : [];
				const images = maxImages && imagesToFetch.length > 0
					? await downloadImages(imagesToFetch, status, warn, signal) // Pass the full image objects so each image's alt text is preserved
					: [];

				// fetch the text content from the body using DOMParser
				const allContent = contentLimit && htmlToPlainText(body) || '';
				
				let content = "";
				if(searchTerms?.length && contentLimit < allContent.length) {
					const padding = `.{0,${contentLimit / (searchTerms.length * 2)}}`;
					const matches = searchTerms
						.map(term => new RegExp(padding + term + padding, 'gi').exec(allContent))
						.filter(match => !!match)
						.sort((a, b) => a.index - b.index); // Sort by index in the content
					let nextMinIndex = 0;
					for(const match of matches) {
						// Ensure we don't return duplicates by merging overlapping matches
						content += match.index >= nextMinIndex
							// The Match does not overlap with the previous one
							? match[0]
							// The match overlaps so we just extend the content to include it
							: match[0].slice(nextMinIndex - match.index);
						nextMinIndex = match.index + match[0].length;
					}
				}
				else content = allContent.slice(0, contentLimit) // Limit text length
					
				return {
					url, title, h1, h2, h3,
					...(links ? { links } : {}),
					...(images ? { images } : {}),
					...(content ? { content } : {}),
				};
			} catch (error:unknown) {
				if (error instanceof DOMException && error.name === "AbortError")
					return "Website visit aborted by user.";
				if (error instanceof Error) {
					warn(`Error during website visit: ${error.message}`);
					return `Error: ${error.message}`;
				}
				warn(`Error during website visit: ${String(error)}`);
				return `Error: ${String(error)}`;
			}
		},
	});


	tools.push(visitWebsiteTool);
	tools.push(viewImagesTool);
	return tools;
}

const undefinedIfAuto = (value:unknown, autoValue:unknown) =>
	value === autoValue ? undefined : value as undefined;

// Extensions that disqualify a URL from being treated as an image (extensionless URLs are allowed)
const nonImageExtensions = ["js", "css", "html", "htm", "json", "xml", "pdf", "zip", "gz", "tar", "mp4", "mp3", "webm", "ogg", "woff", "woff2", "ttf", "eot"];

const mimeToExtension: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"image/avif": "avif",
	"image/bmp": "bmp",
	"image/tiff": "tiff",
};

const spoofedUserAgents = [
	// Random realistic user agents to spoof when fetching pages
	"Mozilla/5.0 (Linux; Android 10; SM-M515F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Mobile Safari/537.36",
	"Mozilla/5.0 (Linux; Android 6.0; E5533) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.101 Mobile Safari/537.36",
	"Mozilla/5.0 (Linux; Android 8.1.0; AX1082) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.83 Mobile Safari/537.36",
	"Mozilla/5.0 (Linux; Android 8.1.0; TM-MID1020A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.96 Safari/537.36",
	"Mozilla/5.0 (Linux; Android 9; POT-LX1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.45 Mobile Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.80 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:97.0) Gecko/20100101 Firefox/97.0",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36 Edg/97.0.1072.71",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.80 Safari/537.36 Edg/98.0.1108.62",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.80 Safari/537.36",
	"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36",
	"Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:97.0) Gecko/20100101 Firefox/97.0",
	"Opera/9.80 (Android 7.0; Opera Mini/36.2.2254/119.132; U; id) Presto/2.12.423 Version/12.16",
]

function spoofHeaders(url:string) {
	const domain = new URL(url).hostname;
	return {
		'User-Agent': spoofedUserAgents[Math.floor(Math.random() * spoofedUserAgents.length)],
		'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
		'Accept-Language': 'en-US,en;q=0.9',
		'Accept-Encoding': 'gzip, deflate, br',
		'Referer': 'https://' + domain + '/',
		'Origin': 'https://' + domain,
		'Connection': 'keep-alive',
		'Upgrade-Insecure-Requests': '1',
		'Sec-Fetch-Dest': 'document',
		'Sec-Fetch-Mode': 'navigate',
		'Sec-Fetch-Site': 'none',
		'Sec-Fetch-User': '?1',
		'Cache-Control': 'max-age=0',
	};
}
