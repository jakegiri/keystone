import Path from 'path';
import fs from 'fs-extra';

import fastGlob from 'fast-glob';
import prettier from 'prettier';
import resolve from 'resolve';
import { GraphQLSchema } from 'graphql';
import type { KeystoneConfig, AdminMetaRootVal, AdminFileToWrite } from '../../types';
import { writeAdminFiles } from '../templates';
import { serializePathForImport } from '../utils/serializePathForImport';

export const formatSource = (src: string, parser: 'babel' | 'babel-ts' = 'babel') =>
  prettier.format(src, { parser, trailingComma: 'es5', singleQuote: true });

function getDoesAdminConfigExist() {
  try {
    const configPath = Path.join(process.cwd(), 'admin', 'config');
    resolve.sync(configPath, { extensions: ['.ts', '.tsx', '.js'], preserveSymlinks: false });
    return true;
  } catch (err: any) {
    if (err.code === 'MODULE_NOT_FOUND') {
      return false;
    }
    throw err;
  }
}

async function writeAdminFile(file: AdminFileToWrite, projectAdminPath: string) {
  const outputFilename = Path.join(projectAdminPath, file.outputPath);
  if (file.mode === 'copy') {
    if (!Path.isAbsolute(file.inputPath)) {
      throw new Error(
        `An inputPath of "${file.inputPath}" was provided to copy but inputPaths must be absolute`
      );
    }
    await fs.ensureDir(Path.dirname(outputFilename));
    // TODO: should we use copyFile or copy?
    await fs.copyFile(file.inputPath, outputFilename);
  }
  if (file.mode === 'write') {
    await fs.outputFile(outputFilename, formatSource(file.src));
  }
  return Path.normalize(outputFilename);
}

export const generateAdminUI = async (
  config: KeystoneConfig,
  graphQLSchema: GraphQLSchema,
  adminMeta: AdminMetaRootVal,
  projectAdminPath: string
) => {
  // Nuke any existing files in our target directory
  await fs.remove(projectAdminPath);
  const publicDirectory = Path.join(projectAdminPath, 'public');

  if (config.images || config.files) {
    await fs.mkdir(publicDirectory, { recursive: true });
  }

  if (config.images) {
    const storagePath = Path.resolve(config.images.local?.storagePath ?? './public/images');
    await fs.mkdir(storagePath, { recursive: true });
    await fs.symlink(
      Path.relative(publicDirectory, storagePath),
      Path.join(publicDirectory, 'images'),
      'junction'
    );
  }

  if (config.files) {
    const storagePath = Path.resolve(config.files.local?.storagePath ?? './public/files');
    await fs.mkdir(storagePath, { recursive: true });
    await fs.symlink(
      Path.relative(publicDirectory, storagePath),
      Path.join(publicDirectory, 'files'),
      'junction'
    );
  }

  // Write out the files configured by the user
  const userPages = config.ui?.getAdditionalFiles?.map(x => x(config)) ?? [];
  const userFilesToWrite = (await Promise.all(userPages)).flat();
  const savedFiles = await Promise.all(
    userFilesToWrite.map(file => writeAdminFile(file, projectAdminPath))
  );
  const uniqueFiles = new Set(savedFiles);

  // Write out the built-in admin UI files. Don't overwrite any user-defined pages.
  const configFileExists = getDoesAdminConfigExist();
  const adminFiles = writeAdminFiles(
    config,
    graphQLSchema,
    adminMeta,
    configFileExists,
    projectAdminPath
  );
  await Promise.all(
    adminFiles
      .filter(x => !uniqueFiles.has(Path.normalize(Path.join(projectAdminPath, x.outputPath))))
      .map(file => writeAdminFile(file, projectAdminPath))
  );

  // Add files to pages/ which point to any files which exist in admin/pages
  const userPagesDir = Path.join(process.cwd(), 'admin', 'pages');
  const files = await fastGlob('**/*.{js,jsx,ts,tsx}', { cwd: userPagesDir });

  await Promise.all(
    files.map(async filename => {
      const outputFilename = Path.join(projectAdminPath, 'pages', filename);
      const path = Path.relative(Path.dirname(outputFilename), Path.join(userPagesDir, filename));
      const importPath = serializePathForImport(path);
      await fs.outputFile(outputFilename, `export { default } from ${importPath}`);
    })
  );
};
