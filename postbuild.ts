// Post-build smoke test: verify the copied tab and gs binaries work.
// Runs after every Electrobun build. Fails the build if resources are broken.
// Also signs extra binaries (tab, gs) before Electrobun's codesign step.

import { join } from "path";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const appName = process.env.ELECTROBUN_APP_NAME;
const buildEnv = process.env.ELECTROBUN_BUILD_ENV;

if (!buildDir) {
	console.log("postBuild: skipping smoke test (not run by an Electrobun build)");
	process.exit(0);
}
// Inside a build, a missing variable must fail it: skipping here would also
// skip signing tab/gs and the .tab file association.
if (!appName || !buildEnv) {
	throw new Error("postBuild: ELECTROBUN_APP_NAME or ELECTROBUN_BUILD_ENV is missing");
}

// Electrobun 2.x passes the plain app.name, while the bundle is channel-suffixed
// for every channel but stable (Tabbo-dev.app, Tabbo-canary.app, Tabbo.app).
const appBundle = join(buildDir, buildEnv === "stable" ? `${appName}.app` : `${appName}-${buildEnv}.app`);
if (!existsSync(appBundle)) {
	throw new Error(`postBuild: app bundle not found at ${appBundle}`);
}

const resourcesApp = join(appBundle, "Contents", "Resources", "app");
const tabBinary = join(resourcesApp, "resources", "bin", "tab");
const gsBinary = join(resourcesApp, "resources", "bin", "gs");
const fontsDir = join(resourcesApp, "resources", "fonts");

const tempDir = join(require("os").tmpdir(), `tabbo-postbuild-${Date.now()}`);
mkdirSync(tempDir, { recursive: true });

const inputFile = join(tempDir, "test.tab");
const outputPs = join(tempDir, "test.ps");
const outputPdf = join(tempDir, "test.pdf");

await Bun.write(inputFile, "b\n1-abc\ne\n");

// Declare the .tab file association by splicing CFBundleDocumentTypes + an
// imported UTI here - postBuild runs before Electrobun's codesign step, which
// re-seals the edit. Not Electrobun's app.fileAssociations (1.18+): it derives
// a UTI per channel from the bundle identifier, exports it (claiming .tab,
// a format Tabbo doesn't own), and conforms it to public.data only, losing
// public.plain-text and the Owner handler rank declared here. Runtime delivery:
// see the open-url handler in src/bun/index.ts.
const infoPlist = join(appBundle, "Contents", "Info.plist");
if (existsSync(infoPlist)) {
	const plistBuddy = "/usr/libexec/PlistBuddy";
	const has = (key: string) => {
		try {
			execSync(`${plistBuddy} -c 'Print :${key}' "${infoPlist}"`, { stdio: "pipe" });
			return true;
		} catch {
			return false;
		}
	};
	if (!has("CFBundleDocumentTypes")) {
		const commands = [
			"Add :CFBundleDocumentTypes array",
			"Add :CFBundleDocumentTypes:0 dict",
			"Add :CFBundleDocumentTypes:0:CFBundleTypeName string 'Lute tablature'",
			"Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Editor",
			"Add :CFBundleDocumentTypes:0:LSHandlerRank string Owner",
			"Add :CFBundleDocumentTypes:0:LSItemContentTypes array",
			"Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string dev.tabbo.tab",
			"Add :UTImportedTypeDeclarations array",
			"Add :UTImportedTypeDeclarations:0 dict",
			"Add :UTImportedTypeDeclarations:0:UTTypeIdentifier string dev.tabbo.tab",
			"Add :UTImportedTypeDeclarations:0:UTTypeDescription string 'Lute tablature'",
			"Add :UTImportedTypeDeclarations:0:UTTypeConformsTo array",
			"Add :UTImportedTypeDeclarations:0:UTTypeConformsTo:0 string public.plain-text",
			"Add :UTImportedTypeDeclarations:0:UTTypeTagSpecification dict",
			"Add :UTImportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension array",
			"Add :UTImportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension:0 string tab",
		];
		for (const command of commands) {
			execSync(`${plistBuddy} -c "${command}" "${infoPlist}"`);
		}
		execSync(`plutil -lint "${infoPlist}"`, { stdio: "pipe" });
		console.log("postBuild: declared .tab document type in Info.plist");
	} else {
		console.log("postBuild: .tab document type already declared");
	}
}

try {
	// Code signing for extra binaries — BEFORE the smoke tests, so they
	// exercise the hardened-runtime-signed binaries that actually ship
	// (notarisation proves a signature exists, not that the binary runs).
	// Electrobun's codesign only auto-signs Mach-O in Contents/MacOS/ and
	// .node files in Resources/app/bun/. Our binaries in resources/bin/
	// need manual signing. postBuild runs before codesign (the CLI's build
	// command calls runHook("postBuild") before codesignAppBundle).
	const developerId = process.env.ELECTROBUN_DEVELOPER_ID;
	if (developerId) {
		const binaries = [tabBinary, gsBinary].filter(existsSync);
		for (const binary of binaries) {
			console.log(`postBuild: signing ${binary}`);
			execSync(
				`codesign --force --timestamp --sign "${developerId}" --options runtime "${binary}"`,
			);
		}
		console.log(`postBuild: signed ${binaries.length} extra binaries`);
	}

	// Smoke test: tab binary
	const tabProc = Bun.spawnSync(
		[tabBinary, "-no-includes", "-o", outputPs, inputFile],
		{
			env: { TABFONTS: fontsDir },
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	if (tabProc.exitCode !== 0) {
		const stderr = new TextDecoder().decode(tabProc.stderr as Uint8Array);
		console.error("postBuild: tab smoke test FAILED");
		console.error(`  tab binary: ${tabBinary}`);
		console.error(`  fonts dir:  ${fontsDir}`);
		console.error(`  exit code:  ${tabProc.exitCode}`);
		if (stderr) console.error(`  stderr:     ${stderr.trim()}`);
		process.exit(1);
	}
	console.log("postBuild: tab smoke test passed");

	// Smoke test: gs binary (PS → PDF)
	if (existsSync(gsBinary)) {
		const gsProc = Bun.spawnSync(
			[
				gsBinary,
				"-q",
				"-dNOPAUSE",
				"-dBATCH",
				"-dSAFER",
				"-sDEVICE=pdfwrite",
				`-sOutputFile=${outputPdf}`,
				outputPs,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);

		if (gsProc.exitCode !== 0) {
			const stderr = new TextDecoder().decode(gsProc.stderr as Uint8Array);
			console.error("postBuild: gs smoke test FAILED");
			console.error(`  gs binary:  ${gsBinary}`);
			console.error(`  exit code:  ${gsProc.exitCode}`);
			if (stderr) console.error(`  stderr:     ${stderr.trim()}`);
			process.exit(1);
		}

		// Verify output is a PDF
		const pdfHeader = await Bun.file(outputPdf).slice(0, 5).text();
		if (pdfHeader !== "%PDF-") {
			console.error("postBuild: gs produced invalid PDF output");
			process.exit(1);
		}
		console.log("postBuild: gs smoke test passed");
	} else {
		console.log("postBuild: gs binary not found, skipping gs smoke test");
	}
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
