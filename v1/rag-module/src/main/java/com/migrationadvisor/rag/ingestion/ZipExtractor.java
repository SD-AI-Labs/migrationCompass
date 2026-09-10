package com.migrationadvisor.rag.ingestion;

import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Extracts an uploaded zip file into a target directory. Guards against
 * "zip-slip" — a malicious zip entry using a path like
 * "../../etc/something" to escape the intended extraction directory. Since
 * this accepts arbitrary user uploads, that check is not optional.
 */
public final class ZipExtractor {

    private ZipExtractor() {}

    public static void extract(MultipartFile zipFile, Path targetDir) throws IOException {
        Path normalizedTarget = targetDir.toAbsolutePath().normalize();

        try (InputStream is = zipFile.getInputStream();
             ZipInputStream zis = new ZipInputStream(is)) {

            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                Path entryPath = normalizedTarget.resolve(entry.getName()).normalize();

                // zip-slip guard: reject any entry that would extract outside targetDir
                if (!entryPath.startsWith(normalizedTarget)) {
                    throw new IOException("Zip entry outside target directory (rejected as unsafe): " + entry.getName());
                }

                if (entry.isDirectory()) {
                    Files.createDirectories(entryPath);
                } else {
                    Files.createDirectories(entryPath.getParent());
                    Files.copy(zis, entryPath, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
                zis.closeEntry();
            }
        }
    }
}
