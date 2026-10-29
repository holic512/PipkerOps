ALTER TABLE "Node" ADD COLUMN "previousCertificateFingerprint" TEXT, ADD COLUMN "certificateRotatedAt" TIMESTAMPTZ(3);
