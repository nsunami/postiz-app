import React, { useCallback, useEffect, useMemo, useState } from 'react';
// @ts-ignore
import Uppy, { BasePlugin, UploadResult, UppyFile } from '@uppy/core';
// @ts-ignore
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import {
  getUppyUploadPlugin,
  WaitForMediaProcessing,
} from '@gitroom/react/helpers/uppy.upload';
import { Dashboard, FileInput, ProgressBar } from '@uppy/react';

// Uppy styles
import { useVariables } from '@gitroom/react/helpers/variable.context';
import Compressor from '@uppy/compressor';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useLaunchStore } from '@gitroom/frontend/components/new-launch/store';
import {
  convertVideoToMp4,
  isQuickTimeVideo,
  MAX_VIDEO_CONVERSION_SIZE_BYTES,
  VideoConversionError,
} from '@gitroom/frontend/components/media/convert.video.to.mp4';
import { uniqBy } from 'lodash';

export class CompressionWrapper<M = any, B = any> extends Compressor<any, any> {
  override async prepareUpload(fileIDs: string[]) {
    const { files } = this.uppy.getState();

    // 1) Skip GIFs (and anything missing)
    const filteredIDs = fileIDs.filter((id) => {
      const f = files[id];
      if (!f) return false;

      const type = f.type ?? '';
      const name = (f.name ?? '').toLowerCase();
      const isGif = type === 'image/gif' || name.endsWith('.gif');

      return !isGif;
    });

    // 2) Let @uppy/compressor do its work (convert/resize/etc)
    return super.prepareUpload(filteredIDs);
  }
}

export function useUppyUploader(props: {
  // @ts-ignore
  onUploadSuccess: (result: UploadResult) => void;
  onStart: () => void;
  onEnd: () => void;
  allowedFileTypes: string;
}) {
  const setLocked = useLaunchStore((state) => state.setLocked);
  const toast = useToaster();
  const t = useT();
  const {
    storageProvider,
    backendUrl,
    disableImageCompression,
    transloadit,
    mediaProcessing,
  } = useVariables();
  const { onUploadSuccess, allowedFileTypes } = props;
  const fetch = useFetch();
  return useMemo(() => {
    // Track file order to maintain original sequence after upload
    let fileOrderIndex = 0;
    // the complete handler runs after the processing plugin, so it has to
    // repeat the specific error instead of overwriting it with the generic one
    let lastProcessingMessage = '';
    // The normalizer takes precedence over Transloadit, so both can stay
    // configured and turning the normalizer off falls back to Transloadit
    const useTransloadit = !mediaProcessing && transloadit.length > 0;
    const serverConvertsVideo = mediaProcessing || useTransloadit;

    const uppy2 = new Uppy({
      autoProceed: true,
      restrictions: {
        // maxNumberOfFiles: 5,
        // allowedFileTypes: allowedFileTypes.split(','),
        maxFileSize: 1000000000, // Default 1GB, but we'll override with custom validation
      },
    });

    // iPhone Safari reports camera/Photos videos as QuickTime, but the rest of
    // the pipeline (storage allow-lists, providers expecting a .mp4) only
    // accepts MP4. When no server-side converter is configured, do it here
    // before the type check so the uploaded file is a real MP4.
    uppy2.addPreProcessor(async (fileIDs) => {
      if (serverConvertsVideo) {
        return;
      }

      const allowsVideo = allowedFileTypes
        .split(',')
        .some((type) => type.trim().startsWith('video/'));

      if (!allowsVideo) {
        return;
      }

      for (const fileID of fileIDs) {
        const file = uppy2.getFile(fileID);
        if (!file || file.isRemote || !isQuickTimeVideo(file)) {
          continue;
        }

        const progressMessage = t(
          'converting_video_to_mp4',
          'Converting video to MP4...'
        );

        const fail = (message: string, error: Error) => {
          uppy2.log(message, 'error');
          uppy2.info(message, 'error', 5000);
          toast.show(message, 'warning');
          if (uppy2.getFile(file.id)) {
            uppy2.removeFile(file.id);
          }
          throw error;
        };

        if ((file.size ?? 0) > MAX_VIDEO_CONVERSION_SIZE_BYTES) {
          fail(
            t(
              'video_too_large_to_convert',
              'This video is too large to convert in the browser. Please trim it or export it as MP4.'
            ),
            new Error('Video is too large to convert')
          );
        }

        const emitProgress = (value: number) => {
          const current = uppy2.getFile(file.id);
          if (current) {
            uppy2.emit('preprocess-progress', current, {
              mode: 'determinate',
              value,
              message: progressMessage,
            });
          }
        };

        emitProgress(0);

        try {
          const converted = await convertVideoToMp4(
            file.data,
            file.name ?? 'video.mov',
            emitProgress
          );

          uppy2.setFileState(file.id, {
            data: converted,
            size: converted.size,
            type: converted.type,
            extension: 'mp4',
            name: converted.name,
            meta: {
              ...file.meta,
              type: converted.type,
              name: converted.name,
            },
          });
        } catch (err) {
          fail(
            err instanceof VideoConversionError && err.reason === 'too_large'
              ? t(
                  'video_too_large_to_convert',
                  'This video is too large to convert in the browser. Please trim it or export it as MP4.'
                )
              : t(
                  'video_conversion_failed',
                  'Could not convert this video to MP4. Please try exporting it as MP4 and uploading again.'
                ),
            err instanceof Error ? err : new Error(String(err))
          );
        } finally {
          const current = uppy2.getFile(file.id);
          if (current) {
            uppy2.emit('preprocess-complete', current);
          }
        }
      }
    });

    // check for valid file types it can be something like this image/*,video/mp4.
    // If it's an image, I need to replace image/* with image/png, image/jpeg, image/jpeg, image/gif (separately)
    uppy2.addPreProcessor((fileIDs) => {
      return new Promise<void>((resolve, reject) => {
        const files = uppy2.getFiles();
        const allowedTypes = allowedFileTypes
          .split(',')
          .map((type) => type.trim());

        // Expand generic types to specific ones
        const expandedTypes = allowedTypes.flatMap((type) => {
          if (type === 'image/*') {
            return [
              'image/png',
              'image/jpeg',
              'image/jpg',
              'image/gif',
              'image/webp',
            ];
          }
          if (type === 'video/*') {
            return ['video/mp4', 'video/mpeg', 'video/quicktime'];
          }
          // the normalizer turns QuickTime into mp4, nothing else is accepted by the bucket
          if (type === 'video/mp4' && mediaProcessing) {
            return ['video/mp4', 'video/quicktime'];
          }
          if (type === 'video/mp4' && transloadit && transloadit.length > 0) {
            return ['video/mp4', 'video/mpeg', 'video/quicktime'];
          }
          return [type];
        });

        for (const file of files) {
          if (fileIDs.includes(file.id)) {
            const fileType = file.type;

            // Check if file type is allowed
            const isAllowed = expandedTypes.some((allowedType) => {
              if (allowedType.endsWith('/*')) {
                const baseType = allowedType.replace('/*', '/');
                return fileType?.startsWith(baseType);
              }
              return fileType === allowedType;
            });

            if (!isAllowed) {
              const error = new Error(
                `File type "${fileType}" is not allowed for file "${file.name}". Allowed types: ${allowedFileTypes}`
              );
              uppy2.log(error.message, 'error');
              uppy2.info(error.message, 'error', 5000);
              toast.show(
                `File type "${fileType}" is not allowed. Allowed types: ${allowedFileTypes}`,
                'warning'
              );
              uppy2.removeFile(file.id);
              return reject(error);
            }
          }
        }

        resolve();
      });
    });

    uppy2.addPreProcessor((fileIDs) => {
      return new Promise<void>((resolve, reject) => {
        const files = uppy2.getFiles();

        for (const file of files) {
          if (fileIDs.includes(file.id)) {
            const isImage = file.type?.startsWith('image/');
            const isVideo = file.type?.startsWith('video/');

            const maxImageSize = 30 * 1024 * 1024; // 30MB
            const maxVideoSize = 1000 * 1024 * 1024; // 1GB

            if (isImage && file.size > maxImageSize) {
              const error = new Error(
                `Image file "${file.name}" is too large. Maximum size allowed is 30MB.`
              );
              uppy2.log(error.message, 'error');
              uppy2.info(error.message, 'error', 5000);
              toast.show(
                `Image file is too large. Maximum size allowed is 30MB.`
              );
              uppy2.removeFile(file.id); // Remove file from queue
              return reject(error);
            }

            if (isVideo && file.size > maxVideoSize) {
              const error = new Error(
                `Video file "${file.name}" is too large. Maximum size allowed is 1GB.`
              );
              uppy2.log(error.message, 'error');
              uppy2.info(error.message, 'error', 5000);
              toast.show(
                `Video file is too large. Maximum size allowed is 1GB.`
              );
              uppy2.removeFile(file.id); // Remove file from queue
              return reject(error);
            }
          }
        }

        resolve();
      });
    });

    // The normalizer takes precedence over Transloadit, so both can stay
    // configured and turning the normalizer off falls back to Transloadit
    const { plugin, options } = getUppyUploadPlugin(
      useTransloadit ? 'transloadit' : storageProvider,
      fetch,
      backendUrl,
      transloadit
    );

    uppy2.use(plugin, options);
    // installed whenever the record can come back "processing", so the backend
    // decides; it passes files through untouched when the row is already ready
    if (storageProvider === 'cloudflare' && !useTransloadit) {
      uppy2.use(WaitForMediaProcessing, {
        fetch,
        processingMessage: t('processing', 'Processing...'),
        fallbackMessage: t(
          'could_not_optimize_file',
          'Could not optimize the file, the original will be used'
        ),
        onMessage: (message: string, kind: 'error' | 'warning') => {
          if (kind === 'error') {
            lastProcessingMessage = message;
          }
          toast.show(message, 'warning');
        },
      });
    }
    // the normalizer resizes on the server, shrinking first would only make it upscale a blurry copy
    if (!disableImageCompression && !mediaProcessing) {
      uppy2.use(CompressionWrapper, {
        convertTypes: ['image/jpeg', 'image/png', 'image/webp'],
        maxWidth: 1000,
        maxHeight: 1000,
        quality: 1,
      });
    }
    // Set additional metadata when a file is added
    uppy2.on('file-added', (file) => {
      setLocked(true);
      uppy2.setFileMeta(file.id, {
        useCloudflare: storageProvider === 'cloudflare' ? 'true' : 'false', // Example of adding a custom field
        addedOrder: fileOrderIndex++, // Track original order for sorting after upload
        // Add more fields as needed
      });
    });
    uppy2.on('error', (result) => {
      // a single file failing leaves the batch running, 'complete' reports it with the rest
      if (Object.keys(uppy2.getState().currentUploads).length) {
        return;
      }
      uppy2.cancelAll();
      setLocked(false);
      props.onEnd();
      fileOrderIndex = 0;
      lastProcessingMessage = '';
    });
    uppy2.on('upload-start', () => {
      props.onStart();
    });
    uppy2.on('complete', async (result) => {
      console.log(result);
      const processingMessage = lastProcessingMessage;
      lastProcessingMessage = '';
      for (const file of [...result.successful, ...(result.failed || [])]) {
        uppy2.removeFile(file.id);
      }

      if (result.failed?.length) {
        toast.show(
          processingMessage ||
            t(
              'some_files_failed_to_upload',
              'Some files failed to upload, please try again'
            ),
          'warning'
        );
      }

      props.onEnd();
      // Sort results by original add order to maintain file sequence
      const sortedSuccessful = [...result.successful].sort((a, b) => {
        const orderA = +((a.meta as any)?.addedOrder ?? 0);
        const orderB = +((b.meta as any)?.addedOrder ?? 0);
        return orderA - orderB;
      });

      if (storageProvider === 'local') {
        setLocked(false);
        fileOrderIndex = 0;
        onUploadSuccess(sortedSuccessful.map((p) => p.response.body));
        return;
      }

      if (useTransloadit) {
        // @ts-ignore
        const allRes = result.transloadit[0].results;
        const toSave = uniqBy<{
          name: string;
          originalName: string;
          order: number;
        }>(
          // @ts-ignore
          Object.values(allRes).flatMap((p: any[]) => {
            return p.flatMap((item) => ({
              name: item.url.split('/').pop(),
              originalName: item.name || '',
              order: +item.user_meta.addedOrder,
            }));
          }),
          (item) => item.name
        );

        const loadAllMedia = (
          await Promise.all(
            toSave.map(async ({ name, originalName, order }) => ({
              file: await (
                await fetch('/media/save-media', {
                  method: 'POST',
                  body: JSON.stringify({
                    name,
                    originalName,
                  }),
                })
              ).json(),
              order,
            }))
          )
        )
          .sort((a, b) => {
            return a.order - b.order;
          })
          .map((p) => p.file);

        setLocked(false);
        fileOrderIndex = 0;
        onUploadSuccess(loadAllMedia);
        return;
      }

      setLocked(false);
      fileOrderIndex = 0;
      onUploadSuccess(sortedSuccessful.map((p) => p.response.body.saved));
    });
    uppy2.on('upload-success', (file, response) => {
      const current = uppy2.getState().files[file.id];
      if (!current) {
        return;
      }
      // @ts-ignore
      uppy2.setFileState(file.id, {
        // @ts-ignore
        progress: current.progress,
        // @ts-ignore
        uploadURL: response.body.Location,
        response: response,
        isPaused: false,
      });
    });
    return uppy2;
  }, []);
}
