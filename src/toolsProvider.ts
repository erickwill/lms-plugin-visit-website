import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { configSchematics } from "./config";
import {
	analyzeImages,
	buildAnalysisPrompt,
	computeMaxTokens,
	downloadImages,
	IMAGE_ANALYSIS_SYSTEM_DEFAULT,
	limitAltText,
	parseImageRef,
	resolveTargetWords,
	resolveVisionModel,
	toMarkdownLink,
} from "./imageVision";

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
	};

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
				const alt = limitAltText(attributes.match(/(?:^|\s)alt=["']([^"']+)["']/i)?.[1] || "");
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

	const viewImagesTool = tool({
		name: "View Images",
		description: "Download and optionally analyze images from online URLs and/or local paths and receive a list of objects with: \n- `image` markdown that can be written directly into your reply (not in a code block) for displaying the downloaded image\n- `analysis` of the image if `wordsPerImage` and/or `focus` are set, powered by local vision model, null if no analysis was performed.",
		parameters: {
			images: z.array(z.string()).min(1).describe("Online image URLs and/or local image paths (or ![alt](path) markdown) to view."),
			wordsPerImage: z.number().int().min(0).max(1000).optional().describe("How long each image's description should be, in words. Set this whenever you analyze so descriptions stay concise; about 100 divided by the number of images is a good target (e.g. ~10 words each for 10 images). Analysis runs when this or focus is set."),
			focus: z.string().optional().describe("What to focus on when analyzing. Providing it enables analysis even when wordsPerImage is omitted. Defaults to a detailed general description."),
		},
		implementation: async ({ images, wordsPerImage, focus }, { status, warn, signal }) => {
			try {
				const items = images.map((ref, i) =>
					parseImageRef(ref, `Image ${i + 1}`),
				);

				const markdowns = await downloadImages(
					ctl, items, status, warn, signal, spoofHeaders,
				);
				if (markdowns.length === 0) {
					warn('Error fetching images');
					return items.map(({ alt }) => ({ image: "!" + toMarkdownLink(limitAltText(alt), ""), analysis: null }));
				}

				let analyses:(string | null)[] = markdowns.map(() => null);
				if (focus || (wordsPerImage !== undefined && wordsPerImage > 0)) {
					const targetWords = resolveTargetWords(images.length, wordsPerImage, focus);
					const model = await resolveVisionModel(ctl);
					if (!model)
						warn("No vision-capable model loaded. Images downloaded without analysis.");
					else {
						const prompt = buildAnalysisPrompt(focus, targetWords);
						const maxTokens = computeMaxTokens(targetWords);
						const result = await analyzeImages(
							ctl, model, markdowns, IMAGE_ANALYSIS_SYSTEM_DEFAULT, prompt, maxTokens, status, warn,
						);
						if (Array.isArray(result))
							analyses = result.map(r => r.analysis);
						else
							warn(result);
					}
				}

				status(`Viewed ${markdowns.length} image${markdowns.length > 1 ? "s" : ""}.`);
				return markdowns.map((image, i) => ({ image, analysis: analyses[i] }));
			}
			catch (error:unknown) {
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
		description: "Visit a website to get its title, headings, links, images, and text content. links and images arrays contain ready-to-use markdown strings, `[text](url)` and `![alt](path)` respectively, to be written directly into your reply for display (not in a code block).",
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
				const config = ctl.getPluginConfig(configSchematics);
				const getConfig = <T>(name:Parameters<typeof config.get>[0], autoValue:T) =>
					config.get(name) === autoValue ? null : config.get(name) as T;
				maxLinks = getConfig("maxLinks", -1) ?? maxLinks ?? 40;
				maxImages = getConfig("maxImages", -1) ?? maxImages ?? 10;
				contentLimit = getConfig("contentLimit", -1) ?? contentLimit ?? 2000;

				const { head, body } = await fetchHTML(url, signal, warn);
				status("Website visited successfully.");

				const title = head.match(/<title>([^<]*)<\/title>/)?.[1] || "";
				const h1 = body.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1] || "";
				const h2 = body.match(/<h2[^>]*>([^<]*)<\/h2>/)?.[1] || "";
				const h3 = body.match(/<h3[^>]*>([^<]*)<\/h3>/)?.[1] || "";
				const links = maxLinks && extractLinks(body, url, maxLinks, searchTerms);
				const imagesToFetch = maxImages ? extractImages(body, url, maxImages, searchTerms) : [];
				const images = maxImages && imagesToFetch.length > 0
					? await downloadImages(ctl, imagesToFetch, status, warn, signal, spoofHeaders)
					: [];

				// fetch the text content from the body using DOMParser
				const allContent = contentLimit && htmlToPlainText(body) || '';

				let content = "";
				if (searchTerms?.length && contentLimit < allContent.length) {
					const padding = `.{0,${contentLimit / (searchTerms.length * 2)}}`;
					const matches = searchTerms
						.map(term => new RegExp(padding + term + padding, 'gi').exec(allContent))
						.filter(match => !!match)
						.sort((a, b) => a.index - b.index); // Sort by index in the content
					let nextMinIndex = 0;
					for (const match of matches) {
						// Ensure we don't return duplicates by merging overlapping matches
						content += match.index >= nextMinIndex
							// The Match does not overlap with the previous one
							? match[0]
							// The match overlaps so we just extend the content to include it
							: match[0].slice(nextMinIndex - match.index);
						nextMinIndex = match.index + match[0].length;
					}
				}
				else content = allContent.slice(0, contentLimit); // Limit text length

				return {
					url, title, h1, h2, h3,
					...(links ? { links } : {}),
					...(images ? { images } : {}),
					...(content ? { content } : {}),
				};
			}
			catch (error:unknown) {
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

// Extensions that disqualify a URL from being treated as an image (extensionless URLs are allowed)
const nonImageExtensions = ["js", "css", "html", "htm", "json", "xml", "pdf", "zip", "gz", "tar", "mp4", "mp3", "webm", "ogg", "woff", "woff2", "ttf", "eot"];

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
];

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
